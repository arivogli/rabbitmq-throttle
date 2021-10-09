import { Channel, connect, Connection, ConsumeMessage, Replies } from 'amqplib';
import { RabbitApi } from './RabbitApi';
import Consume = Replies.Consume;
import { use } from 'chai';

type UserKey = string;
type NumberOfConsumers = number;

type Users = Record<UserKey, NumberOfConsumers>;

type ConsumeHandler = (payload: {
	message: ConsumeMessage | null;
	connection: Connection | null;
	channel: Channel | null;
}) => Promise<void>;

interface Options {
	pattern: string; // the pattern name to create queues. e.x requests.user_id
	rabbitUrl: string;
	rabbitHttpUrl: string;
	users: () => Users;
	consumeHandler: ConsumeHandler;
	exchangeName?: string;
	exchangeFanoutName?: string;
	connection?: Connection;
}

enum EXCHANGE {
	name = 'throttle',
	fanout = 'throttle.remove',
}

export class Throttle {
	private readonly consumers: Record<string, string[]>;
	private rabbitApi: RabbitApi;
	private connection: Connection | null;
	private internalChannel: Channel | null;
	private clientChannel: Channel | null;
	private exchangeName: string = EXCHANGE.name;
	private exchangeFanoutName: string = EXCHANGE.fanout;

	public constructor(private options: Options) {
		this.consumers = {};
		this.rabbitApi = new RabbitApi(options.rabbitHttpUrl);
		this.connection = null;
		this.internalChannel = null;
		this.clientChannel = null;
	}

	public async init() {
		this.connection =
			this.options.connection || (await connect(this.options.rabbitUrl));

		this.exchangeName = this.options.exchangeName || EXCHANGE.name;
		this.exchangeFanoutName =
			this.options.exchangeFanoutName || EXCHANGE.fanout;

		this.internalChannel = await this.connection.createChannel();
		this.clientChannel = await this.connection.createChannel();

		await this.internalChannel.assertExchange(this.exchangeName, 'direct');
		await this.internalChannel.assertExchange(
			this.exchangeFanoutName,
			'fanout'
		);

		await this.internalChannel.assertQueue('add', {});
		await this.internalChannel.assertQueue('remove', {});
		await this.internalChannel.assertQueue('sync', {});

		await this.internalChannel.bindQueue('add', this.exchangeName, 'add');
		await this.internalChannel.bindQueue(
			'sync',
			this.exchangeFanoutName,
			'sync'
		);
		await this.internalChannel.bindQueue(
			'remove',
			this.exchangeFanoutName,
			'remove'
		);
		await this.internalChannel.consume('add', async (msg) => {
			if (!msg || !this.internalChannel || !this.clientChannel) {
				return;
			}
			const queueName = msg?.content.toString();
			if (!queueName) {
				await this.internalChannel.ack(msg);
				return;
			}
			await this.clientChannel.assertQueue(queueName, {
				maxPriority: 10,
			});
			await this.clientChannel.bindQueue(
				queueName,
				this.exchangeFanoutName,
				queueName
			);
			const consume: Consume = await this.clientChannel.consume(
				queueName,
				async (message) =>
					this.options.consumeHandler({
						message,
						channel: this.clientChannel,
						connection: this.connection,
					})
			);
			const tags = this.consumers[queueName] || [];
			tags.push(consume.consumerTag);
			this.consumers[queueName] = tags;
			await this.internalChannel.ack(msg);
			console.log(
				`Queue:[${queueName}] adding consumer:[${consume.consumerTag}]`
			);
		});
		await this.internalChannel.consume('remove', async (msg) => {
			if (!msg || !this.clientChannel) {
				return;
			}
			const { queueName, tags: tagsForRemove } = JSON.parse(
				msg?.content.toString()
			);
			if (!queueName) {
				return;
			}
			const tags = this.consumers[queueName];
			if (tags && tags.length) {
				for (const tag of tagsForRemove) {
					if (tags.includes(tag)) {
						await this.clientChannel.cancel(tag);
						console.log(
							`Queue:[${queueName}] removing consumer:[${tag}]`
						);
					}
				}
			}
		});
		await this.internalChannel.consume('sync', async (msg) => {
			if (!msg || !this.internalChannel) {
				return;
			}
			const consumers = await this.rabbitApi.getConsumers();
			const mapConsumers = consumers.reduce<
				Record<string, { nr: number; tags: string[] }>
			>((acc, c) => {
				if (acc[c.queue.name]) {
					acc[c.queue.name].nr += 1;
					acc[c.queue.name].tags.push(c.consumer_tag);
					return acc;
				}
				acc[c.queue.name] = {
					nr: 1,
					tags: [c.consumer_tag],
				};
				return acc;
			}, {});

			const users = await this.options.users();
			const usersQueues = Object.keys(users).reduce<
				Record<string, number>
			>((acc, e) => {
				acc[`${this.options.pattern}.${e}`] = users[e];
				return acc;
			}, {});
			for (const [userQueue, desiredNrOfConsumers] of Object.entries(
				usersQueues
			)) {
				const exists = mapConsumers[userQueue];
				if (!exists) {
					for (let i = 0; i < desiredNrOfConsumers; i++) {
						this.internalChannel.publish(
							this.exchangeName,
							'add',
							Buffer.from(userQueue)
						);
					}
					continue;
				}
				const { nr: actualNumberOfConsumers, tags } =
					mapConsumers[userQueue];
				if (desiredNrOfConsumers > actualNumberOfConsumers) {
					for (
						let i = 0;
						i < desiredNrOfConsumers - actualNumberOfConsumers;
						i++
					) {
						this.internalChannel.publish(
							this.exchangeName,
							'add',
							Buffer.from(userQueue)
						);
					}
					continue;
				}
				if (desiredNrOfConsumers < actualNumberOfConsumers) {
					const nrOfConsumersToRemove =
						actualNumberOfConsumers - desiredNrOfConsumers;
					const consumersToRemove = tags.slice(
						0,
						nrOfConsumersToRemove
					);

					for (let i = 0; i < consumersToRemove.length; i++) {
						this.internalChannel.publish(
							this.exchangeFanoutName,
							'remove',
							Buffer.from(
								JSON.stringify({
									queueName: userQueue,
									tags: consumersToRemove,
								})
							)
						);
					}
				}
			}
			await this.internalChannel.ack(msg);
		});
	}

	private addQueue(queueName: string) {
		this.internalChannel?.publish(
			this.exchangeName,
			'add',
			Buffer.from(queueName)
		);
	}
}
