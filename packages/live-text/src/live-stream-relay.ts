import { randomUUID } from "node:crypto";
import { EventType } from "@ag-ui/core";
import {
	classifyLiveStreamFailure,
	decodeAgUiLiveStreamEvent,
	LIVE_STREAM_MAX_BYTES,
	LIVE_STREAM_MAX_EVENT_BYTES,
	LIVE_STREAM_MAX_EVENTS,
	type LiveStreamEvent,
	LiveStreamStoreError,
	RUN_CANCELLED_EVENT_TYPE,
} from "./live-stream-events";
import {
	disabledLiveStreamTelemetry,
	type LiveStreamOperation,
	type LiveStreamResult,
	type LiveStreamTelemetry,
} from "./live-stream-telemetry";
import {
	requirePositiveInteger,
	validateLiveStreamRunId,
} from "./live-stream-validation";

const DEFAULT_BACKLOG_WAIT_MS = 250;

export interface LiveStreamRelayOptions {
	backlogWaitMs?: number;
	telemetry?: LiveStreamTelemetry;
	/** Lower hard limits for relay contract tests only. */
	testLimits?: {
		maxBufferBytes?: number;
		maxEvents?: number;
	};
	testHooks?: {
		afterEventPublished?: (context: {
			eventType: LiveStreamEvent["type"];
			terminal: boolean;
		}) => void;
		afterLiveEventBuffered?: (ordinal: number) => void;
		afterLiveSubscribed?: () => Promise<void>;
		beforeBacklogReply?: () => Promise<void>;
		failEventPublishWhen?: (context: {
			eventType: LiveStreamEvent["type"];
			terminal: boolean;
		}) => boolean;
	};
}

export interface LiveStreamProducer {
	append(event: Uint8Array): Promise<void>;
	publishTerminal(event: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

export type LiveStreamAttachResult =
	| { outcome: "attached"; events: AsyncIterable<Uint8Array> }
	| { outcome: "no_producer" }
	| { outcome: "relay_failed" }
	| { outcome: "aborted" };

export interface LiveStreamRelay {
	openProducer(runId: string): Promise<LiveStreamProducer>;
	attach(runId: string, signal: AbortSignal): Promise<LiveStreamAttachResult>;
	close(): Promise<void>;
}

export interface LiveStreamSubscription {
	close(): Promise<void>;
}

export interface LiveStreamRelayTransport {
	publish(channel: string, message: string): Promise<void>;
	publishFailure(channel: string, message: string): Promise<void>;
	subscribe(
		channel: string,
		onMessage: (message: string) => void,
		onFailure?: (error: unknown) => void,
	): Promise<LiveStreamSubscription>;
	close(): Promise<void>;
}

interface LiveEventEnvelope {
	type: "event";
	ordinal: number;
	event: string;
}

interface LiveFailureEnvelope {
	type: "relay_failed";
}

type LiveEnvelope = LiveEventEnvelope | LiveFailureEnvelope;

interface BacklogEventsReply {
	outcome: "backlog";
	count: number;
	events: string[];
}

interface BacklogFailureReply {
	outcome: "relay_failed";
}

type BacklogReply = BacklogEventsReply | BacklogFailureReply;

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
	readonly #testHooks: LiveStreamRelayOptions["testHooks"];
	readonly #producers = new Set<BufferedLiveStreamProducer>();
	#closed = false;

	constructor(
		transport: LiveStreamRelayTransport,
		channelPrefix: string,
		options: LiveStreamRelayOptions = {},
	) {
		this.#transport = transport;
		this.#channelPrefix = channelPrefix;
		this.#backlogWaitMs = requirePositiveInteger(
			options.backlogWaitMs ?? DEFAULT_BACKLOG_WAIT_MS,
			"backlogWaitMs",
		);
		this.#maxBufferBytes = Math.min(
			requirePositiveInteger(
				options.testLimits?.maxBufferBytes ?? LIVE_STREAM_MAX_BYTES,
				"maxBufferBytes",
			),
			LIVE_STREAM_MAX_BYTES,
		);
		this.#maxEvents = Math.min(
			requirePositiveInteger(
				options.testLimits?.maxEvents ?? LIVE_STREAM_MAX_EVENTS,
				"maxEvents",
			),
			LIVE_STREAM_MAX_EVENTS,
		);
		this.#telemetry = options.telemetry ?? disabledLiveStreamTelemetry;
		this.#testHooks = options.testHooks;
	}

	async openProducer(runId: string): Promise<LiveStreamProducer> {
		this.#assertOpen();
		validateLiveStreamRunId(runId, "runId");
		const producer = new BufferedLiveStreamProducer(
			this.#transport,
			this.#requestChannel(runId),
			this.#liveChannel(runId),
			this.#maxBufferBytes,
			this.#maxEvents,
			this.#telemetry,
			this.#testHooks,
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
		validateLiveStreamRunId(runId, "runId");
		const startedAt = performance.now();
		recordTelemetry(this.#telemetry, "attach_attempt", "started");
		if (signal.aborted) {
			recordTelemetry(this.#telemetry, "attach_attempt", "aborted", {
				durationMs: performance.now() - startedAt,
			});
			return { outcome: "aborted" };
		}

		const pendingLive = new Map<number, string>();
		const queue = new AsyncQueue<Uint8Array>();
		let nextOrdinal: number | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let liveSubscription: LiveStreamSubscription | undefined;
		let replySubscription: LiveStreamSubscription | undefined;
		let settleAborted: (() => void) | undefined;

		const closeSubscriptions = async () => {
			await Promise.allSettled([
				liveSubscription?.close(),
				replySubscription?.close(),
			]);
		};
		const abort = () => {
			if (settled) {
				queue.end();
				return;
			}
			settleAborted?.();
		};
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
			settleAborted = () => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				void closeSubscriptions();
				recordTelemetry(this.#telemetry, "attach_attempt", "aborted", {
					durationMs: performance.now() - startedAt,
				});
				resolve({ outcome: "aborted" });
			};
			const settleAttached = (reply: BacklogEventsReply) => {
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
			const settleRelayFailed = () => {
				if (settled) return;
				settled = true;
				if (timeout !== undefined) clearTimeout(timeout);
				signal.removeEventListener("abort", abort);
				queue.fail(new LiveStreamStoreError("relay_failed"));
				void closeSubscriptions();
				recordTelemetry(this.#telemetry, "attach_attempt", "failure", {
					reason: "relay_failed",
					durationMs: performance.now() - startedAt,
				});
				resolve({ outcome: "relay_failed" });
			};

			void (async () => {
				liveSubscription = await this.#transport.subscribe(
					this.#liveChannel(runId),
					(message) => {
						const envelope = parseLiveEnvelope(message);
						if (!envelope) return;
						if (envelope.type === "relay_failed") {
							if (!settled) {
								settleRelayFailed();
								return;
							}
							queue.fail(new LiveStreamStoreError("relay_failed"));
							return;
						}
						if (nextOrdinal !== undefined && envelope.ordinal < nextOrdinal) {
							return;
						}
						pendingLive.set(envelope.ordinal, envelope.event);
						this.#testHooks?.afterLiveEventBuffered?.(envelope.ordinal);
						drainLive();
					},
					() => {
						if (settled) {
							queue.fail(new LiveStreamStoreError("relay_failed"));
							return;
						}
						settleRelayFailed();
					},
				);
				await this.#testHooks?.afterLiveSubscribed?.();
				if (settled) {
					await liveSubscription.close();
					return;
				}
				const replyChannel = this.#replyChannel(runId);
				replySubscription = await this.#transport.subscribe(
					replyChannel,
					(message) => {
						const reply = parseBacklogReply(message);
						if (reply?.outcome === "backlog") settleAttached(reply);
						if (reply?.outcome === "relay_failed") settleRelayFailed();
					},
					() => settleRelayFailed(),
				);
				if (settled) {
					await replySubscription.close();
					return;
				}
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
		if (this.#closed) throw new LiveStreamStoreError("relay_closed");
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
	readonly #testHooks: LiveStreamRelayOptions["testHooks"];
	readonly #onClose: () => void;
	readonly #events: string[] = [];
	readonly #backlogReplies = new Set<Promise<void>>();
	#requestSubscription: LiveStreamSubscription | undefined;
	#appendTail = Promise.resolve();
	#bufferBytes = 0;
	#closed = false;
	#failed = false;
	#terminalPublished = false;

	constructor(
		transport: LiveStreamRelayTransport,
		requestChannel: string,
		liveChannel: string,
		maxBufferBytes: number,
		maxEvents: number,
		telemetry: LiveStreamTelemetry,
		testHooks: LiveStreamRelayOptions["testHooks"],
		onClose: () => void,
	) {
		this.#transport = transport;
		this.#requestChannel = requestChannel;
		this.#liveChannel = liveChannel;
		this.#maxBufferBytes = maxBufferBytes;
		this.#maxEvents = maxEvents;
		this.#telemetry = telemetry;
		this.#testHooks = testHooks;
		this.#onClose = onClose;
	}

	async open(): Promise<void> {
		this.#requestSubscription = await this.#transport.subscribe(
			this.#requestChannel,
			(message) => {
				if (this.#closed) return;
				const request = parseBacklogRequest(message);
				if (!request) return;
				const publishing = (async () => {
					await this.#testHooks?.beforeBacklogReply?.();
					const reply: BacklogReply = this.#failed
						? { outcome: "relay_failed" }
						: {
								outcome: "backlog",
								count: this.#events.length,
								events: [...this.#events],
							};
					await this.#transport.publish(
						request.replyChannel,
						JSON.stringify(reply),
					);
				})().then(
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
				void publishing.then(() => this.#backlogReplies.delete(publishing));
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
			if (this.#closed) throw new LiveStreamStoreError("producer_closed");
			if (this.#failed) {
				throw new LiveStreamStoreError("producer_failed");
			}
			if (this.#terminalPublished) {
				throw new LiveStreamStoreError("terminal_already_published");
			}
			const parsed = decodeAgUiLiveStreamEvent(event);
			if (isTerminalType(parsed.type) !== terminal) {
				throw new LiveStreamStoreError(
					terminal ? "terminal_required" : "terminal_not_allowed",
				);
			}
			if (event.byteLength > LIVE_STREAM_MAX_EVENT_BYTES) {
				throw new LiveStreamStoreError("event_too_large");
			}
			if (this.#bufferBytes + event.byteLength > this.#maxBufferBytes) {
				const error = new LiveStreamStoreError("stream_bytes_exceeded");
				this.#fail();
				throw error;
			}
			if (this.#events.length + 1 > this.#maxEvents) {
				const error = new LiveStreamStoreError("stream_events_exceeded");
				this.#fail();
				throw error;
			}
			const serialized = decodeEvent(event);
			const envelope: LiveEventEnvelope = {
				type: "event",
				ordinal: this.#events.length,
				event: serialized,
			};
			this.#events.push(serialized);
			this.#bufferBytes += event.byteLength;
			try {
				if (
					this.#testHooks?.failEventPublishWhen?.({
						eventType: parsed.type,
						terminal,
					})
				) {
					throw new Error("injected Live Stream publish failure");
				}
				await this.#transport.publish(
					this.#liveChannel,
					JSON.stringify(envelope),
				);
				recordTelemetry(this.#telemetry, "publish", "success");
				if (terminal) this.#terminalPublished = true;
				this.#testHooks?.afterEventPublished?.({
					eventType: parsed.type,
					terminal,
				});
			} catch (error) {
				recordTelemetry(this.#telemetry, "publish", "failure", {
					reason: classifyLiveStreamFailure(error),
				});
				this.#fail();
				throw new LiveStreamStoreError("relay_failed");
			}
		});
		this.#appendTail = append.catch(() => {});
		return append;
	}

	#fail(): void {
		if (this.#failed) return;
		this.#failed = true;
		void this.#transport
			.publishFailure(
				this.#liveChannel,
				JSON.stringify({ type: "relay_failed" } satisfies LiveFailureEnvelope),
			)
			.catch(() => {
				// A transport outage may also prevent the failure signal. Redis
				// subscriber errors remain a second path to the same reader outcome.
			});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		if (!this.#terminalPublished && !this.#failed) this.#fail();
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
		if (this.#ended) return;
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
		const parsed = JSON.parse(message) as Record<string, unknown>;
		if (parsed.type === "relay_failed") return { type: "relay_failed" };
		if (
			parsed.type !== "event" ||
			!Number.isSafeInteger(parsed.ordinal) ||
			(typeof parsed.ordinal === "number" ? parsed.ordinal : -1) < 0 ||
			typeof parsed.event !== "string"
		) {
			return undefined;
		}
		return {
			type: "event",
			ordinal: parsed.ordinal as number,
			event: parsed.event,
		};
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
		const parsed = JSON.parse(message) as Record<string, unknown>;
		if (parsed.outcome === "relay_failed") {
			return { outcome: "relay_failed" };
		}
		if (
			parsed.outcome !== "backlog" ||
			!Number.isSafeInteger(parsed.count) ||
			(typeof parsed.count === "number" ? parsed.count : -1) < 0 ||
			!Array.isArray(parsed.events) ||
			parsed.events.some((event) => typeof event !== "string") ||
			parsed.events.length !== parsed.count
		) {
			return undefined;
		}
		return {
			outcome: "backlog",
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
