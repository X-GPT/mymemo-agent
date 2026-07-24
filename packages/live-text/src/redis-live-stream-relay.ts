import { createClient } from "redis";
import { LiveStreamStoreError } from "./live-stream-events";
import {
	type LiveStreamRelay,
	type LiveStreamRelayOptions,
	type LiveStreamRelayTransport,
	type LiveStreamSubscription,
	ProducerBufferedLiveStreamRelay,
} from "./live-stream-relay";
import {
	requirePositiveInteger,
	validateLiveStreamDeployment,
} from "./live-stream-validation";

type RedisClient = ReturnType<typeof createClient>;
const FAILURE_PUBLISH_TIMEOUT_MS = 250;
const DEFAULT_OPERATION_TIMEOUT_MS = 1_000;

export interface RedisLiveStreamRelayOptions extends LiveStreamRelayOptions {
	url: string;
	deployment: string;
	/** Bounds each Redis connect/command so Live Stream failure cannot stall a Run. */
	operationTimeoutMs?: number;
}

class RedisRelayTransport implements LiveStreamRelayTransport {
	readonly #url: string;
	readonly #publisher: RedisClient;
	readonly #failurePublishers = new Set<RedisClient>();
	readonly #failurePublishes = new Set<Promise<void>>();
	readonly #subscribers = new Set<RedisClient>();
	readonly #operationTimeoutMs: number;
	#connecting: Promise<void> | undefined;
	#closed = false;

	constructor(url: string, operationTimeoutMs: number) {
		this.#url = url;
		this.#operationTimeoutMs = operationTimeoutMs;
		this.#publisher = createClient({
			url,
			socket: {
				connectTimeout: operationTimeoutMs,
				reconnectStrategy: false,
			},
		});
		this.#publisher.on("error", () => {});
	}

	async publish(channel: string, message: string): Promise<void> {
		this.#assertOpen();
		await withTimeout(
			(async () => {
				await this.#connectPublisher();
				await this.#publisher.publish(channel, message);
			})(),
			this.#operationTimeoutMs,
			() => destroyClient(this.#publisher),
		);
	}

	publishFailure(channel: string, message: string): Promise<void> {
		this.#assertOpen();
		const publisher = createClient({
			url: this.#url,
			socket: {
				connectTimeout: FAILURE_PUBLISH_TIMEOUT_MS,
				reconnectStrategy: false,
			},
		});
		publisher.on("error", () => {});
		this.#failurePublishers.add(publisher);
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const operation = (async () => {
			await publisher.connect();
			await publisher.publish(channel, message);
		})();
		const timedOut = new Promise<never>((_, reject) => {
			timeout = setTimeout(() => {
				if (publisher.isOpen) publisher.destroy();
				reject(new LiveStreamStoreError("relay_failed"));
			}, FAILURE_PUBLISH_TIMEOUT_MS);
		});
		const publishing = Promise.race([operation, timedOut]).finally(() => {
			if (timeout !== undefined) clearTimeout(timeout);
			this.#failurePublishers.delete(publisher);
			if (publisher.isOpen) publisher.destroy();
		});
		this.#failurePublishes.add(publishing);
		void publishing.then(
			() => this.#failurePublishes.delete(publishing),
			() => this.#failurePublishes.delete(publishing),
		);
		return publishing;
	}

	async subscribe(
		channel: string,
		onMessage: (message: string) => void,
		onFailure?: (error: unknown) => void,
	): Promise<LiveStreamSubscription> {
		this.#assertOpen();
		const subscriber = createClient({
			url: this.#url,
			socket: {
				connectTimeout: this.#operationTimeoutMs,
				reconnectStrategy: false,
			},
		});
		let closed = false;
		subscriber.on("error", (error) => {
			if (!closed) onFailure?.(error);
		});
		this.#subscribers.add(subscriber);
		try {
			await withTimeout(
				(async () => {
					await subscriber.connect();
					await subscriber.subscribe(channel, onMessage);
				})(),
				this.#operationTimeoutMs,
				() => destroyClient(subscriber),
			);
		} catch (error) {
			this.#subscribers.delete(subscriber);
			destroyClient(subscriber);
			throw error;
		}
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				this.#subscribers.delete(subscriber);
				destroyClient(subscriber);
			},
		};
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		for (const publisher of this.#failurePublishers) {
			if (publisher.isOpen) publisher.destroy();
		}
		for (const subscriber of this.#subscribers) destroyClient(subscriber);
		this.#subscribers.clear();
		destroyClient(this.#publisher);
		await Promise.allSettled(this.#failurePublishes);
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
		if (this.#closed) throw new LiveStreamStoreError("relay_closed");
	}
}

export function createRedisLiveStreamRelay(
	options: RedisLiveStreamRelayOptions,
): LiveStreamRelay {
	validateLiveStreamDeployment(options.deployment);
	const operationTimeoutMs = requirePositiveInteger(
		options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS,
		"operationTimeoutMs",
	);
	return new ProducerBufferedLiveStreamRelay(
		new RedisRelayTransport(options.url, operationTimeoutMs),
		`${options.deployment}:mymemo:agui`,
		options,
	);
}

async function withTimeout<T>(
	operation: Promise<T>,
	timeoutMs: number,
	onTimeout: () => void,
): Promise<T> {
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<never>((_, reject) => {
		timeout = setTimeout(() => {
			onTimeout();
			reject(new LiveStreamStoreError("relay_failed"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([operation, timedOut]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

function destroyClient(client: RedisClient): void {
	try {
		client.destroy();
	} catch {
		// Destroy is idempotent from the relay's point of view.
	}
}
