import { createClient } from "redis";
import { z } from "zod";
import type { LiveTextTelemetry } from "./telemetry";

export * from "./redis-live-stream-store";
export * from "./telemetry";

export const LIVE_TEXT_MAX_CHUNK_LENGTH = 16_384;
export const LIVE_TEXT_MAX_WIRE_BYTES = 100_000;
const LIVE_TEXT_MAX_ID_LENGTH = 128;

/**
 * Resolve the additive production Live-transport secret. Invalid configuration
 * is deliberately indistinguishable from missing configuration to callers: both
 * disable only live delivery until the hard cutover makes it required. The
 * returned URL is authenticated and TLS-only, but remains a secret and must not
 * be logged.
 */
export function resolveLiveTextRedisUrl(
	raw: string | undefined,
	options: { allowInsecureLoopback?: boolean } = {},
): string | undefined {
	if (!raw) return undefined;
	try {
		const url = new URL(raw);
		if (
			options.allowInsecureLoopback === true &&
			url.protocol === "redis:" &&
			(url.hostname === "127.0.0.1" ||
				url.hostname === "localhost" ||
				url.hostname === "[::1]")
		) {
			return raw;
		}
		if (url.protocol !== "rediss:" || !url.hostname || !url.password) {
			return undefined;
		}
		return raw;
	} catch {
		return undefined;
	}
}

export const LiveTextMessageSchema = z
	.object({
		runId: z.string().min(1).max(LIVE_TEXT_MAX_ID_LENGTH),
		messageId: z.string().min(1).max(LIVE_TEXT_MAX_ID_LENGTH),
		deltaIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		text: z.string().min(1).max(LIVE_TEXT_MAX_CHUNK_LENGTH),
	})
	.strict();

export type LiveTextMessage = z.infer<typeof LiveTextMessageSchema>;

export type LiveTextDropReport =
	| { type: "message_ids"; messageIds: string[] }
	| { type: "tracking_overflow" }
	| { type: "invalid_wire_message" };

export interface LiveTextPublisher {
	publish(
		message: LiveTextMessage,
		options?: { signal?: AbortSignal },
	): Promise<void>;
}

export interface LiveTextSubscription {
	readAvailable(): LiveTextMessage[];
	readDroppedMessages(): LiveTextDropReport;
	waitForMessage(options?: {
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<boolean>;
	close(): Promise<void>;
}

export interface LiveTextSubscriber {
	subscribe(runId: string): Promise<LiveTextSubscription>;
}

export interface LiveTextTransport
	extends LiveTextPublisher,
		LiveTextSubscriber {
	close(): Promise<void>;
}

class BufferedLiveTextSubscription implements LiveTextSubscription {
	readonly #buffer: LiveTextMessage[] = [];
	readonly #droppedMessageIds = new Set<string>();
	readonly #waiters = new Set<(available: boolean) => void>();
	#droppedMessageIdsOverflowed = false;
	#invalidWireMessageDropped = false;
	#closed = false;

	constructor(
		readonly runId: string,
		private readonly maxBufferedMessages: number,
		private readonly onClose: () => void | Promise<void>,
	) {}

	enqueue(message: LiveTextMessage): void {
		if (this.#closed) return;
		if (this.#buffer.length >= this.maxBufferedMessages) {
			if (
				!this.#droppedMessageIdsOverflowed &&
				!this.#droppedMessageIds.has(message.messageId)
			) {
				if (this.#droppedMessageIds.size >= this.maxBufferedMessages) {
					this.#droppedMessageIds.clear();
					this.#droppedMessageIdsOverflowed = true;
				} else {
					this.#droppedMessageIds.add(message.messageId);
				}
			}
			this.#wake(true);
			return;
		}
		this.#buffer.push(message);
		this.#wake(true);
	}

	dropInvalidWireMessage(): void {
		if (this.#closed) return;
		this.#invalidWireMessageDropped = true;
		this.#wake(true);
	}

	readAvailable(): LiveTextMessage[] {
		if (this.#closed) return [];
		return this.#buffer.splice(0);
	}

	readDroppedMessages(): LiveTextDropReport {
		if (this.#closed) return { type: "message_ids", messageIds: [] };
		if (this.#invalidWireMessageDropped) {
			this.#invalidWireMessageDropped = false;
			return { type: "invalid_wire_message" };
		}
		if (this.#droppedMessageIdsOverflowed) {
			this.#droppedMessageIdsOverflowed = false;
			this.#droppedMessageIds.clear();
			return { type: "tracking_overflow" };
		}
		const messageIds = [...this.#droppedMessageIds];
		this.#droppedMessageIds.clear();
		return { type: "message_ids", messageIds };
	}

	async waitForMessage(
		options: { timeoutMs?: number; signal?: AbortSignal } = {},
	): Promise<boolean> {
		if (this.#closed || options.signal?.aborted) return false;
		if (this.#buffer.length > 0) return true;

		return new Promise<boolean>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (available: boolean) => {
				if (settled) return;
				settled = true;
				this.#waiters.delete(onMessage);
				if (timer !== undefined) clearTimeout(timer);
				options.signal?.removeEventListener("abort", onAbort);
				resolve(available);
			};
			const onMessage = (available: boolean) => finish(available);
			const onAbort = () => finish(false);
			this.#waiters.add(onMessage);
			options.signal?.addEventListener("abort", onAbort, { once: true });
			if (options.timeoutMs !== undefined) {
				timer = setTimeout(() => finish(false), options.timeoutMs);
			}
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#buffer.length = 0;
		this.#droppedMessageIds.clear();
		this.#droppedMessageIdsOverflowed = false;
		this.#invalidWireMessageDropped = false;
		this.#wake(false);
		await this.onClose();
	}

	#wake(available: boolean): void {
		for (const waiter of this.#waiters) waiter(available);
		this.#waiters.clear();
	}
}

/** Deterministic process-local transport used by integration tests. */
export class InMemoryLiveTextTransport implements LiveTextTransport {
	readonly #subscriptions = new Map<
		string,
		Set<BufferedLiveTextSubscription>
	>();
	#closed = false;

	constructor(private readonly maxBufferedMessages = 64) {
		if (!Number.isSafeInteger(maxBufferedMessages) || maxBufferedMessages < 1) {
			throw new Error("maxBufferedMessages must be a positive integer");
		}
	}

	async publish(
		message: LiveTextMessage,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		if (this.#closed) throw new Error("Live text transport is closed");
		if (options.signal?.aborted) return;
		const parsed = LiveTextMessageSchema.parse(message);
		if (options.signal?.aborted) return;
		for (const subscription of this.#subscriptions.get(parsed.runId) ?? []) {
			subscription.enqueue(parsed);
		}
	}

	async subscribe(runId: string): Promise<LiveTextSubscription> {
		if (this.#closed) throw new Error("Live text transport is closed");
		const parsedRunId = LiveTextMessageSchema.shape.runId.parse(runId);
		const subscriptions = this.#subscriptions.get(parsedRunId) ?? new Set();
		this.#subscriptions.set(parsedRunId, subscriptions);
		let subscription: BufferedLiveTextSubscription;
		subscription = new BufferedLiveTextSubscription(
			parsedRunId,
			this.maxBufferedMessages,
			() => {
				subscriptions.delete(subscription);
				if (subscriptions.size === 0) this.#subscriptions.delete(parsedRunId);
			},
		);
		subscriptions.add(subscription);
		return subscription;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		const subscriptions = [...this.#subscriptions.values()].flatMap((set) => [
			...set,
		]);
		await Promise.all(
			subscriptions.map((subscription) => subscription.close()),
		);
		this.#subscriptions.clear();
	}
}

export type RedisLiveTextSignal =
	| "degraded"
	| "recovered"
	| "invalid_message"
	| "oversized_message";

/** Map a Redis transport signal to its bounded payload-free telemetry event. */
export function reportRedisLiveTextSignal(
	telemetry: LiveTextTelemetry,
	signal: RedisLiveTextSignal,
): void {
	if (signal === "degraded") {
		telemetry.degraded("redis_connection");
	} else if (signal === "recovered") {
		telemetry.recovered("redis_connection");
	} else {
		telemetry.record("malformed", "adapter_message", "dropped");
	}
}

export interface RedisLiveTextTransportOptions {
	/** Authenticated rediss:// production secret, or redis:// in disposable tests. */
	url: string;
	maxBufferedMessages?: number;
	operationTimeoutMs?: number;
	reconnectMaxDelayMs?: number;
	onSignal?: (signal: RedisLiveTextSignal) => void;
}

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_REDIS_OPERATION_TIMEOUT_MS = 250;
const DEFAULT_REDIS_RECONNECT_MAX_DELAY_MS = 3_000;

/** Exact per-Run Pub/Sub channel fixed by ADR-0008. */
export function liveTextChannel(runId: string): string {
	return `run:${LiveTextMessageSchema.shape.runId.parse(runId)}`;
}

function timeoutAfter(ms: number): {
	promise: Promise<never>;
	cancel(): void;
} {
	let timer: ReturnType<typeof setTimeout>;
	return {
		promise: new Promise((_, reject) => {
			timer = setTimeout(
				() => reject(new Error("Live text Redis operation timed out")),
				ms,
			);
		}),
		cancel: () => clearTimeout(timer),
	};
}

/**
 * Lazy, best-effort Redis Pub/Sub adapter. No connection is made at
 * construction time, so Redis can never become a boot or readiness dependency.
 */
class RedisLiveTextTransport implements LiveTextTransport {
	readonly #url: string;
	readonly #maxBufferedMessages: number;
	readonly #operationTimeoutMs: number;
	readonly #reconnectMaxDelayMs: number;
	readonly #onSignal?: (signal: RedisLiveTextSignal) => void;
	readonly #subscriptions = new Set<BufferedLiveTextSubscription>();
	#publisher: RedisClient | undefined;
	#degraded = false;
	#closed = false;

	constructor(options: RedisLiveTextTransportOptions) {
		this.#url = options.url;
		this.#maxBufferedMessages = options.maxBufferedMessages ?? 64;
		this.#operationTimeoutMs =
			options.operationTimeoutMs ?? DEFAULT_REDIS_OPERATION_TIMEOUT_MS;
		this.#reconnectMaxDelayMs =
			options.reconnectMaxDelayMs ?? DEFAULT_REDIS_RECONNECT_MAX_DELAY_MS;
		this.#onSignal = options.onSignal;
		if (
			!Number.isSafeInteger(this.#maxBufferedMessages) ||
			this.#maxBufferedMessages < 1
		) {
			throw new Error("maxBufferedMessages must be a positive integer");
		}
		if (
			!Number.isSafeInteger(this.#operationTimeoutMs) ||
			this.#operationTimeoutMs < 1
		) {
			throw new Error("operationTimeoutMs must be a positive integer");
		}
	}

	async publish(
		message: LiveTextMessage,
		options: { signal?: AbortSignal } = {},
	): Promise<void> {
		if (this.#closed) throw new Error("Live text transport is closed");
		if (options.signal?.aborted) return;
		const parsed = LiveTextMessageSchema.parse(message);
		const wireMessage = JSON.stringify(parsed);
		if (Buffer.byteLength(wireMessage) > LIVE_TEXT_MAX_WIRE_BYTES) {
			throw new Error("Live text wire message is too large");
		}
		const client = this.#publisher ?? this.#createClient();
		this.#publisher = client;
		try {
			if (!client.isOpen) {
				await this.#bounded(client.connect(), options.signal);
			}
			if (options.signal?.aborted) return;
			await this.#bounded(
				client.publish(liveTextChannel(parsed.runId), wireMessage),
				options.signal,
			);
		} catch (error) {
			this.#markDegraded();
			if (this.#publisher === client) this.#publisher = undefined;
			this.#destroy(client);
			throw error;
		}
	}

	async subscribe(runId: string): Promise<LiveTextSubscription> {
		if (this.#closed) throw new Error("Live text transport is closed");
		const parsedRunId = LiveTextMessageSchema.shape.runId.parse(runId);
		const channel = liveTextChannel(parsedRunId);
		const client = this.#createClient();
		let subscription: BufferedLiveTextSubscription;
		subscription = new BufferedLiveTextSubscription(
			parsedRunId,
			this.#maxBufferedMessages,
			async () => {
				this.#subscriptions.delete(subscription);
				try {
					if (client.isReady) {
						await this.#bounded(client.unsubscribe(channel));
					}
				} catch {
					this.#markDegraded();
				} finally {
					this.#destroy(client);
				}
			},
		);
		this.#subscriptions.add(subscription);
		try {
			await this.#bounded(client.connect());
			await this.#bounded(
				client.subscribe(channel, (wireMessage) => {
					this.#acceptWireMessage(subscription, parsedRunId, wireMessage);
				}),
			);
			return subscription;
		} catch (error) {
			this.#markDegraded();
			await subscription.close();
			throw error;
		}
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.all(
			[...this.#subscriptions].map((subscription) => subscription.close()),
		);
		const publisher = this.#publisher;
		this.#publisher = undefined;
		if (publisher) this.#destroy(publisher);
	}

	#acceptWireMessage(
		subscription: BufferedLiveTextSubscription,
		runId: string,
		wireMessage: string,
	): void {
		if (Buffer.byteLength(wireMessage) > LIVE_TEXT_MAX_WIRE_BYTES) {
			this.#emitSignal("oversized_message");
			subscription.dropInvalidWireMessage();
			return;
		}
		try {
			const parsed = LiveTextMessageSchema.safeParse(JSON.parse(wireMessage));
			if (!parsed.success || parsed.data.runId !== runId) {
				this.#emitSignal("invalid_message");
				subscription.dropInvalidWireMessage();
				return;
			}
			subscription.enqueue(parsed.data);
		} catch {
			this.#emitSignal("invalid_message");
			subscription.dropInvalidWireMessage();
		}
	}

	#createClient(): RedisClient {
		const client = createClient({
			url: this.#url,
			socket: {
				connectTimeout: this.#operationTimeoutMs,
				reconnectStrategy: (retries) =>
					Math.min(50 * 2 ** Math.min(retries, 10), this.#reconnectMaxDelayMs),
			},
		});
		client.on("error", () => this.#markDegraded());
		client.on("reconnecting", () => this.#markDegraded());
		client.on("ready", () => this.#markRecovered());
		return client;
	}

	async #bounded<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
		const timeout = timeoutAfter(this.#operationTimeoutMs);
		let onAbort: (() => void) | undefined;
		const aborted = new Promise<never>((_, reject) => {
			if (!signal) return;
			onAbort = () => reject(new Error("Live text Redis operation aborted"));
			if (signal.aborted) onAbort();
			else signal.addEventListener("abort", onAbort, { once: true });
		});
		try {
			return await Promise.race([operation, timeout.promise, aborted]);
		} finally {
			timeout.cancel();
			if (onAbort) signal?.removeEventListener("abort", onAbort);
		}
	}

	#destroy(client: RedisClient): void {
		try {
			client.destroy();
		} catch {
			// Cleanup is best-effort and must not fail a Run or service shutdown.
		}
	}

	#markDegraded(): void {
		if (this.#degraded) return;
		this.#degraded = true;
		this.#emitSignal("degraded");
	}

	#markRecovered(): void {
		if (!this.#degraded) return;
		this.#degraded = false;
		this.#emitSignal("recovered");
	}

	#emitSignal(signal: RedisLiveTextSignal): void {
		try {
			this.#onSignal?.(signal);
		} catch {
			// Telemetry is optional and never receives credentials or payloads.
		}
	}
}

export function createRedisLiveTextTransport(
	options: RedisLiveTextTransportOptions,
): LiveTextTransport {
	return new RedisLiveTextTransport(options);
}

export class LiveTextDisabledError extends Error {
	override name = "LiveTextDisabledError" as const;

	constructor() {
		super("Live text is disabled");
	}
}

export const disabledLiveTextSubscriber: LiveTextSubscriber = {
	async subscribe() {
		throw new LiveTextDisabledError();
	},
};
