import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import {
	classifyLiveStreamFailure,
	decodeAgUiLiveStreamEvent,
	LIVE_STREAM_MAX_BYTES,
	LIVE_STREAM_MAX_EVENT_BYTES,
	LIVE_STREAM_MAX_EVENTS,
	LiveStreamStoreError,
	RUN_CANCELLED_EVENT_TYPE,
} from "./live-stream-events";
import {
	disabledLiveStreamTelemetry,
	type LiveStreamOperation,
	type LiveStreamResult,
	type LiveStreamTelemetry,
} from "./live-stream-telemetry";

const DEFAULT_BACKLOG_WAIT_MS = 250;

export interface LiveStreamRelayOptions {
	backlogWaitMs?: number;
	telemetry?: LiveStreamTelemetry;
	/** Lower hard limits for relay contract tests only. */
	testLimits?: {
		maxBufferBytes?: number;
		maxEvents?: number;
	};
}

export interface LiveStreamProducer {
	append(event: Uint8Array): Promise<void>;
	publishTerminal(event: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export type LiveStreamAttachResult =
	| { outcome: "attached"; events: AsyncIterable<Uint8Array> }
	| { outcome: "no_producer" };

export interface LiveStreamRelay {
	openProducer(runId: string): Promise<LiveStreamProducer>;
	attach(runId: string, signal: AbortSignal): Promise<LiveStreamAttachResult>;
	close(): Promise<void>;
}

export interface LiveStreamRelayTransport {
	publish(channel: string, message: string): Promise<void>;
	subscribe(
		channel: string,
		onMessage: (message: string) => void,
	): Promise<{ close(): Promise<void> }>;
	close(): Promise<void>;
}

interface LiveEnvelope {
	ordinal: number;
	event: string;
}

interface BacklogReply {
	count: number;
	events: string[];
}

interface BacklogRequest {
	replyChannel: string;
}

export class ProducerBufferedLiveStreamRelay implements LiveStreamRelay {
	readonly #transport: LiveStreamRelayTransport;
	readonly #channelPrefix: string;
	readonly #backlogWaitMs: number;
	readonly #maxBufferBytes: number;
	readonly #maxEvents: number;
	readonly #telemetry: LiveStreamTelemetry;
	readonly #producers = new Set<BufferedLiveStreamProducer>();
	#closed = false;

	constructor(
		transport: LiveStreamRelayTransport,
		channelPrefix: string,
		options: LiveStreamRelayOptions = {},
	) {
		this.#transport = transport;
		this.#channelPrefix = channelPrefix;
		this.#backlogWaitMs = positiveInteger(
			options.backlogWaitMs ?? DEFAULT_BACKLOG_WAIT_MS,
			"backlogWaitMs",
		);
		this.#maxBufferBytes = Math.min(
			positiveInteger(
				options.testLimits?.maxBufferBytes ?? LIVE_STREAM_MAX_BYTES,
				"maxBufferBytes",
			),
			LIVE_STREAM_MAX_BYTES,
		);
		this.#maxEvents = Math.min(
			positiveInteger(
				options.testLimits?.maxEvents ?? LIVE_STREAM_MAX_EVENTS,
				"maxEvents",
			),
			LIVE_STREAM_MAX_EVENTS,
		);
		this.#telemetry = options.telemetry ?? disabledLiveStreamTelemetry;
	}

	async openProducer(runId: string): Promise<LiveStreamProducer> {
		this.#assertOpen();
		validateRunId(runId);
		const producer = new BufferedLiveStreamProducer(
			this.#transport,
			this.#requestChannel(runId),
			this.#liveChannel(runId),
			this.#maxBufferBytes,
			this.#maxEvents,
			this.#telemetry,
			() => this.#producers.delete(producer),
		);
		await producer.open();
		this.#producers.add(producer);
		return producer;
	}

	async attach(
		runId: string,
		signal: AbortSignal,
	): Promise<LiveStreamAttachResult> {
		this.#assertOpen();
		validateRunId(runId);
		const startedAt = performance.now();
		recordTelemetry(this.#telemetry, "attach_attempt", "started");
		if (signal.aborted) {
			recordTelemetry(this.#telemetry, "attach_attempt", "aborted", {
				durationMs: performance.now() - startedAt,
			});
			return { outcome: "no_producer" };
		}

		const pendingLive = new Map<number, string>();
		const queue = new AsyncQueue<Uint8Array>();
		let nextOrdinal: number | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let liveSubscription: { close(): Promise<void> } | undefined;
		let replySubscription: { close(): Promise<void> } | undefined;

		const closeSubscriptions = async () => {
			await Promise.allSettled([
				liveSubscription?.close(),
				replySubscription?.close(),
			]);
		};
		const abort = () => queue.end();
		signal.addEventListener("abort", abort, { once: true });

		const drainLive = () => {
			while (nextOrdinal !== undefined) {
				const event = pendingLive.get(nextOrdinal);
				if (event === undefined) return;
				pendingLive.delete(nextOrdinal);
				nextOrdinal += 1;
				queue.push(encodeEvent(event));
				if (isTerminalEvent(event)) queue.end();
			}
		};

		const attached = new Promise<LiveStreamAttachResult>((resolve, reject) => {
			const settleAttached = (reply: BacklogReply) => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				nextOrdinal = reply.count;
				for (const ordinal of pendingLive.keys()) {
					if (ordinal < reply.count) pendingLive.delete(ordinal);
				}
				for (const event of reply.events) {
					queue.push(encodeEvent(event));
					if (isTerminalEvent(event)) queue.end();
				}
				drainLive();
				void replySubscription?.close();
				recordTelemetry(this.#telemetry, "attach_attempt", "success", {
					durationMs: performance.now() - startedAt,
				});
				resolve({
					outcome: "attached",
					events: queue.iterate(async () => {
						signal.removeEventListener("abort", abort);
						await closeSubscriptions();
					}),
				});
			};

			void (async () => {
				liveSubscription = await this.#transport.subscribe(
					this.#liveChannel(runId),
					(message) => {
						const envelope = parseLiveEnvelope(message);
						if (!envelope) return;
						if (nextOrdinal !== undefined && envelope.ordinal < nextOrdinal) {
							return;
						}
						pendingLive.set(envelope.ordinal, envelope.event);
						drainLive();
					},
				);
				const replyChannel = this.#replyChannel(runId);
				replySubscription = await this.#transport.subscribe(
					replyChannel,
					(message) => {
						const reply = parseBacklogReply(message);
						if (reply) settleAttached(reply);
					},
				);
				timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", abort);
					void closeSubscriptions();
					recordTelemetry(this.#telemetry, "attach_attempt", "no_producer", {
						durationMs: performance.now() - startedAt,
					});
					resolve({ outcome: "no_producer" });
				}, this.#backlogWaitMs);
				await this.#transport.publish(
					this.#requestChannel(runId),
					JSON.stringify({ replyChannel } satisfies BacklogRequest),
				);
			})().catch(async (error) => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				await closeSubscriptions();
				queue.fail(error);
				recordTelemetry(this.#telemetry, "attach_attempt", "failure", {
					reason: classifyLiveStreamFailure(error),
					durationMs: performance.now() - startedAt,
				});
				reject(error);
			});
		});

		return attached;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.all([...this.#producers].map((producer) => producer.close()));
		await this.#transport.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new Error("Live Stream relay is closed");
	}

	#liveChannel(runId: string): string {
		return `${this.#channelPrefix}:{${runId}}:live`;
	}

	#requestChannel(runId: string): string {
		return `${this.#channelPrefix}:{${runId}}:request`;
	}

	#replyChannel(runId: string): string {
		return `${this.#channelPrefix}:{${runId}}:reply:${randomUUID()}`;
	}
}

class BufferedLiveStreamProducer implements LiveStreamProducer {
	readonly #transport: LiveStreamRelayTransport;
	readonly #requestChannel: string;
	readonly #liveChannel: string;
	readonly #maxBufferBytes: number;
	readonly #maxEvents: number;
	readonly #telemetry: LiveStreamTelemetry;
	readonly #onClose: () => void;
	readonly #events: string[] = [];
	readonly #backlogReplies = new Set<Promise<void>>();
	#requestSubscription: { close(): Promise<void> } | undefined;
	#appendTail = Promise.resolve();
	#bufferBytes = 0;
	#closed = false;
	#terminalPublished = false;

	constructor(
		transport: LiveStreamRelayTransport,
		requestChannel: string,
		liveChannel: string,
		maxBufferBytes: number,
		maxEvents: number,
		telemetry: LiveStreamTelemetry,
		onClose: () => void,
	) {
		this.#transport = transport;
		this.#requestChannel = requestChannel;
		this.#liveChannel = liveChannel;
		this.#maxBufferBytes = maxBufferBytes;
		this.#maxEvents = maxEvents;
		this.#telemetry = telemetry;
		this.#onClose = onClose;
	}

	async open(): Promise<void> {
		this.#requestSubscription = await this.#transport.subscribe(
			this.#requestChannel,
			(message) => {
				if (this.#closed) return;
				const request = parseBacklogRequest(message);
				if (!request) return;
				const reply: BacklogReply = {
					count: this.#events.length,
					events: [...this.#events],
				};
				const publishing = this.#transport
					.publish(request.replyChannel, JSON.stringify(reply))
					.then(
						() => {
							recordTelemetry(this.#telemetry, "backlog_request", "success");
						},
						(error) => {
							recordTelemetry(this.#telemetry, "backlog_request", "failure", {
								reason: classifyLiveStreamFailure(error),
							});
						},
					);
				this.#backlogReplies.add(publishing);
				void publishing.finally(() => this.#backlogReplies.delete(publishing));
			},
		);
	}

	append(event: Uint8Array): Promise<void> {
		return this.#publish(event, false);
	}

	publishTerminal(event: Uint8Array): Promise<void> {
		return this.#publish(event, true);
	}

	#publish(event: Uint8Array, terminal: boolean): Promise<void> {
		const append = this.#appendTail.then(async () => {
			if (this.#closed) throw new Error("Live Stream producer is closed");
			if (this.#terminalPublished) {
				throw new Error("Live Stream terminal event was already published");
			}
			const parsed = decodeAgUiLiveStreamEvent(event);
			if (isTerminalType(parsed.type) !== terminal) {
				throw new Error(
					terminal
						? "publishTerminal requires a terminal AG-UI event"
						: "append does not accept terminal AG-UI events",
				);
			}
			if (event.byteLength > LIVE_STREAM_MAX_EVENT_BYTES) {
				throw new LiveStreamStoreError("event_too_large");
			}
			if (this.#bufferBytes + event.byteLength > this.#maxBufferBytes) {
				throw new LiveStreamStoreError("stream_bytes_exceeded");
			}
			if (this.#events.length + 1 > this.#maxEvents) {
				throw new LiveStreamStoreError("stream_events_exceeded");
			}
			const serialized = decodeEvent(event);
			const envelope: LiveEnvelope = {
				ordinal: this.#events.length,
				event: serialized,
			};
			this.#events.push(serialized);
			this.#bufferBytes += event.byteLength;
			try {
				await this.#transport.publish(
					this.#liveChannel,
					JSON.stringify(envelope),
				);
				recordTelemetry(this.#telemetry, "publish", "success");
				if (terminal) this.#terminalPublished = true;
			} catch (error) {
				recordTelemetry(this.#telemetry, "publish", "failure", {
					reason: classifyLiveStreamFailure(error),
				});
				throw error;
			}
		});
		this.#appendTail = append.catch(() => {});
		return append;
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#appendTail;
		try {
			await this.#requestSubscription?.close();
			await Promise.all(this.#backlogReplies);
		} finally {
			this.#events.length = 0;
			this.#bufferBytes = 0;
			this.#onClose();
		}
	}
}

class AsyncQueue<T> {
	readonly #values: T[] = [];
	readonly #waiters: Array<() => void> = [];
	#ended = false;
	#error: unknown;

	push(value: T): void {
		if (this.#ended) return;
		this.#values.push(value);
		this.#wake();
	}

	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#wake();
	}

	fail(error: unknown): void {
		this.#error = error;
		this.end();
	}

	async *iterate(onClose: () => Promise<void>): AsyncIterable<T> {
		try {
			while (true) {
				const value = this.#values.shift();
				if (value !== undefined) {
					yield value;
					continue;
				}
				if (this.#ended) {
					if (this.#error !== undefined) throw this.#error;
					return;
				}
				await new Promise<void>((resolve) => this.#waiters.push(resolve));
			}
		} finally {
			await onClose();
		}
	}

	#wake(): void {
		for (const resolve of this.#waiters.splice(0)) resolve();
	}
}

function parseLiveEnvelope(message: string): LiveEnvelope | undefined {
	try {
		const parsed = JSON.parse(message) as Partial<LiveEnvelope>;
		if (
			!Number.isSafeInteger(parsed.ordinal) ||
			(parsed.ordinal ?? -1) < 0 ||
			typeof parsed.event !== "string"
		) {
			return undefined;
		}
		return { ordinal: parsed.ordinal as number, event: parsed.event };
	} catch {
		return undefined;
	}
}

function parseBacklogRequest(message: string): BacklogRequest | undefined {
	try {
		const parsed = JSON.parse(message) as Partial<BacklogRequest>;
		return typeof parsed.replyChannel === "string" &&
			parsed.replyChannel.length > 0
			? { replyChannel: parsed.replyChannel }
			: undefined;
	} catch {
		return undefined;
	}
}

function parseBacklogReply(message: string): BacklogReply | undefined {
	try {
		const parsed = JSON.parse(message) as Partial<BacklogReply>;
		if (
			!Number.isSafeInteger(parsed.count) ||
			(parsed.count ?? -1) < 0 ||
			!Array.isArray(parsed.events) ||
			parsed.events.some((event) => typeof event !== "string") ||
			parsed.events.length !== parsed.count
		) {
			return undefined;
		}
		return {
			count: parsed.count as number,
			events: parsed.events as string[],
		};
	} catch {
		return undefined;
	}
}

function decodeEvent(event: Uint8Array): string {
	return new TextDecoder("utf-8", { fatal: true }).decode(event);
}

function encodeEvent(event: string): Uint8Array {
	return new TextEncoder().encode(event);
}

function isTerminalEvent(event: string): boolean {
	try {
		const type = (JSON.parse(event) as { type?: unknown }).type;
		return isTerminalType(type);
	} catch {
		return false;
	}
}

function isTerminalType(type: unknown): boolean {
	return (
		type === EventType.RUN_FINISHED ||
		type === EventType.RUN_ERROR ||
		type === RUN_CANCELLED_EVENT_TYPE
	);
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

function recordTelemetry(
	telemetry: LiveStreamTelemetry,
	operation: LiveStreamOperation,
	result: LiveStreamResult,
	options?: {
		reason?: ReturnType<typeof classifyLiveStreamFailure>;
		durationMs?: number;
	},
): void {
	try {
		telemetry.record(operation, result, options);
	} catch {
		// Observability must never change Live Stream delivery.
	}
}

function validateRunId(runId: string): void {
	if (
		runId.length < 1 ||
		runId.length > 128 ||
		!/^[A-Za-z0-9_-]+$/.test(runId)
	) {
		throw new Error("runId must be a path-safe Run identifier");
	}
}
