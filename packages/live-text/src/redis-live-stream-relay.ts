import { createClient } from "redis";
import {
	type LiveStreamRelay,
	type LiveStreamRelayOptions,
	type LiveStreamRelayTransport,
	ProducerBufferedLiveStreamRelay,
} from "./live-stream-relay";

type RedisClient = ReturnType<typeof createClient>;

export interface RedisLiveStreamRelayOptions extends LiveStreamRelayOptions {
	url: string;
	deployment: string;
}

class RedisRelayTransport implements LiveStreamRelayTransport {
	readonly #url: string;
	readonly #publisher: RedisClient;
	readonly #subscribers = new Set<RedisClient>();
	#connecting: Promise<void> | undefined;
	#closed = false;

	constructor(url: string) {
		this.#url = url;
		this.#publisher = createClient({ url });
		this.#publisher.on("error", () => {});
	}

	async publish(channel: string, message: string): Promise<void> {
		this.#assertOpen();
		await this.#connectPublisher();
		await this.#publisher.publish(channel, message);
	}

	async subscribe(
		channel: string,
		onMessage: (message: string) => void,
	): Promise<{ close(): Promise<void> }> {
		this.#assertOpen();
		const subscriber = createClient({ url: this.#url });
		subscriber.on("error", () => {});
		this.#subscribers.add(subscriber);
		try {
			await subscriber.connect();
			await subscriber.subscribe(channel, onMessage);
		} catch (error) {
			this.#subscribers.delete(subscriber);
			if (subscriber.isOpen) subscriber.destroy();
			throw error;
		}
		let closed = false;
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				this.#subscribers.delete(subscriber);
				if (!subscriber.isOpen) return;
				try {
					await subscriber.unsubscribe(channel);
				} finally {
					subscriber.destroy();
				}
			},
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const subscriber of this.#subscribers) subscriber.destroy();
		this.#subscribers.clear();
		if (this.#publisher.isOpen) this.#publisher.destroy();
	}

	async #connectPublisher(): Promise<void> {
		if (this.#publisher.isReady) return;
		if (!this.#connecting) {
			this.#connecting = this.#publisher
				.connect()
				.then(() => {})
				.finally(() => {
					this.#connecting = undefined;
				});
		}
		await this.#connecting;
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Live Stream relay is closed");
	}
}

export function createRedisLiveStreamRelay(
	options: RedisLiveStreamRelayOptions,
): LiveStreamRelay {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(options.deployment)) {
		throw new Error("deployment must be a path-safe identifier");
	}
	return new ProducerBufferedLiveStreamRelay(
		new RedisRelayTransport(options.url),
		`${options.deployment}:mymemo:agui`,
		options,
	);
}
