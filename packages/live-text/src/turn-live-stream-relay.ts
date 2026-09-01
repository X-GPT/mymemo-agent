import { type UIMessageChunk, uiMessageChunkSchema } from "ai";
import { createInMemoryRelayTransport } from "./in-memory-live-stream-relay";
import {
	LIVE_STREAM_MAX_EVENT_BYTES,
	LiveStreamRelayError,
} from "./live-stream-events";
import { AsyncQueue, type LiveStreamRelayTransport } from "./live-stream-relay";
import {
	type LiveStreamTurnKey,
	validateLiveStreamDeployment,
	validateLiveStreamTurnKey,
} from "./live-stream-validation";
import {
	createRedisRelayTransport,
	type RedisRelayTransportOptions,
} from "./redis-live-stream-relay";

/**
 * The v2 Live Stream lane (spec #654, chunk contract amended on #658): a
 * Turn's UIMessage chunks published over the payload-agnostic relay transport
 * on a per-Turn channel keyed on Conversation id + message id (the message id
 * is client-chosen and unique only within its Conversation — #694 review).
 * The payload grammar is the stock AI SDK v7
 * `UIMessageChunk` vocabulary (`ai@7.0.83`) — no custom chunk types; one
 * assistant UIMessage per Turn, so the stock terminal chunks ARE the Turn's
 * Outcome: `finish` (done), `abort` (interrupted), `error` (error). The lane
 * carries the JSON chunk payloads only; the SSE envelope is the HTTP
 * response's job (#667). Pure pub/sub — deliberately no producer-buffered
 * backlog and no request/reply re-attach. The Live Stream dies with its Turn;
 * a late or disconnected subscriber recovers from durable history, never from
 * this lane.
 */

/** The stock chunk types that end a Turn's Live Stream — exactly one per
 * Turn. `finish-step` closes a provider call inside the Turn, never the
 * subscription. */
function isTerminalChunkType(type: unknown): boolean {
	return type === "finish" || type === "abort" || type === "error";
}

/** Relay control signal for a died stream; not a UIMessage chunk (the stock
 * grammar rejects it at publish, so the payload namespace stays clean). */
const TURN_RELAY_FAILED_EVENT_TYPE = "turn-relay-failed" as const;

export interface TurnLiveStreamPublisher {
	/** Publish one UIMessage chunk value. Chunks validate against the stock
	 * AI SDK v7 `UIMessageChunk` grammar; unknown or custom chunk types,
	 * malformed chunks, and oversize chunks are rejected without failing the
	 * stream. A terminal chunk (`finish` | `abort` | `error`) latches the
	 * publisher — exactly one per Turn. */
	publish(chunk: unknown): Promise<void>;
	close(): Promise<void>;
}

export interface TurnLiveStreamRelay {
	openPublisher(turn: LiveStreamTurnKey): TurnLiveStreamPublisher;
	/** Subscribe to a Turn's live chunks, each a serialized UIMessage chunk
	 * ready for SSE framing. Delivery starts at subscription time — there is
	 * no backlog; earlier chunks are simply missed. The iteration ends after
	 * the Turn's terminal chunk (`finish` | `abort` | `error`), or when
	 * `signal` aborts. */
	subscribe(
		turn: LiveStreamTurnKey,
		signal: AbortSignal,
	): Promise<AsyncIterable<string>>;
	close(): Promise<void>;
}

export interface TurnLiveStreamRelayOptions {
	testHooks?: {
		failPublishWhen?: (chunkType: string) => boolean;
	};
}

class PubSubTurnLiveStreamRelay implements TurnLiveStreamRelay {
	readonly #transport: LiveStreamRelayTransport;
	readonly #channelPrefix: string;
	readonly #testHooks: TurnLiveStreamRelayOptions["testHooks"];
	readonly #publishers = new Set<TransportTurnLiveStreamPublisher>();
	#closed = false;

	constructor(
		transport: LiveStreamRelayTransport,
		channelPrefix: string,
		options: TurnLiveStreamRelayOptions = {},
	) {
		this.#transport = transport;
		this.#channelPrefix = channelPrefix;
		this.#testHooks = options.testHooks;
	}

	openPublisher(turn: LiveStreamTurnKey): TurnLiveStreamPublisher {
		this.#assertOpen();
		validateLiveStreamTurnKey(turn);
		const publisher = new TransportTurnLiveStreamPublisher(
			this.#transport,
			this.#channel(turn),
			this.#testHooks,
			() => this.#publishers.delete(publisher),
		);
		this.#publishers.add(publisher);
		return publisher;
	}

	async subscribe(
		turn: LiveStreamTurnKey,
		signal: AbortSignal,
	): Promise<AsyncIterable<string>> {
		this.#assertOpen();
		validateLiveStreamTurnKey(turn);
		const queue = new AsyncQueue<string>();
		if (signal.aborted) {
			queue.end();
			return queue.iterate(async () => {});
		}
		const subscription = await this.#transport.subscribe(
			this.#channel(turn),
			(message) => {
				let type: unknown;
				try {
					type = (JSON.parse(message) as { type?: unknown }).type;
				} catch {
					return;
				}
				if (type === TURN_RELAY_FAILED_EVENT_TYPE) {
					queue.fail(new LiveStreamRelayError("relay_failed"));
					return;
				}
				queue.push(message);
				if (isTerminalChunkType(type)) queue.end();
			},
			() => queue.fail(new LiveStreamRelayError("relay_failed")),
		);
		const abort = () => queue.end();
		signal.addEventListener("abort", abort, { once: true });
		return queue.iterate(async () => {
			signal.removeEventListener("abort", abort);
			await subscription.close();
		});
	}

	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await Promise.all(
			[...this.#publishers].map((publisher) => publisher.close()),
		);
		await this.#transport.close();
	}

	#assertOpen(): void {
		if (this.#closed) throw new LiveStreamRelayError("relay_closed");
	}

	#channel(turn: LiveStreamTurnKey): string {
		return `${this.#channelPrefix}:{${turn.conversationId}}:${turn.messageId}:live`;
	}
}

class TransportTurnLiveStreamPublisher implements TurnLiveStreamPublisher {
	readonly #transport: LiveStreamRelayTransport;
	readonly #channel: string;
	readonly #testHooks: TurnLiveStreamRelayOptions["testHooks"];
	readonly #onClose: () => void;
	#publishTail = Promise.resolve();
	#closed = false;
	#failed = false;
	#terminalPublished = false;

	constructor(
		transport: LiveStreamRelayTransport,
		channel: string,
		testHooks: TurnLiveStreamRelayOptions["testHooks"],
		onClose: () => void,
	) {
		this.#transport = transport;
		this.#channel = channel;
		this.#testHooks = testHooks;
		this.#onClose = onClose;
	}

	async publish(chunk: unknown): Promise<void> {
		const publish = this.#publishTail.then(async () => {
			if (this.#closed) throw new LiveStreamRelayError("producer_closed");
			if (this.#failed) throw new LiveStreamRelayError("producer_failed");
			if (this.#terminalPublished) {
				throw new LiveStreamRelayError("terminal_already_published");
			}
			const validated = await validateUiMessageChunk(chunk);
			// Serialize the caller's value, not the schema output, so validation
			// can never alter what goes over the wire.
			let serialized: string;
			try {
				serialized = JSON.stringify(chunk);
			} catch {
				throw new LiveStreamRelayError("invalid_event");
			}
			if (Buffer.byteLength(serialized) > LIVE_STREAM_MAX_EVENT_BYTES) {
				throw new LiveStreamRelayError("event_too_large");
			}
			try {
				if (this.#testHooks?.failPublishWhen?.(validated.type)) {
					throw new Error("injected Turn Live Stream publish failure");
				}
				await this.#transport.publish(this.#channel, serialized);
			} catch {
				this.#fail();
				throw new LiveStreamRelayError("relay_failed");
			}
			if (isTerminalChunkType(validated.type)) {
				this.#terminalPublished = true;
			}
		});
		this.#publishTail = publish.catch(() => {});
		return publish;
	}

	#fail(): void {
		if (this.#failed) return;
		this.#failed = true;
		void this.#transport
			.publishFailure(
				this.#channel,
				JSON.stringify({ type: TURN_RELAY_FAILED_EVENT_TYPE }),
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
		await this.#publishTail;
		this.#onClose();
	}
}

/** Validate one parsed chunk against the stock AI SDK v7 grammar. */
async function validateUiMessageChunk(value: unknown): Promise<UIMessageChunk> {
	const result = await uiMessageChunkSchema().validate?.(value);
	if (!result?.success) throw new LiveStreamRelayError("invalid_event");
	return result.value;
}

export function createInMemoryTurnLiveStreamRelay(
	options: TurnLiveStreamRelayOptions = {},
): TurnLiveStreamRelay {
	return new PubSubTurnLiveStreamRelay(
		createInMemoryRelayTransport(),
		"memory:mymemo:turn",
		options,
	);
}

export interface RedisTurnLiveStreamRelayOptions
	extends RedisRelayTransportOptions,
		TurnLiveStreamRelayOptions {
	deployment: string;
}

export function createRedisTurnLiveStreamRelay(
	options: RedisTurnLiveStreamRelayOptions,
): TurnLiveStreamRelay {
	validateLiveStreamDeployment(options.deployment);
	return new PubSubTurnLiveStreamRelay(
		createRedisRelayTransport(options),
		`${options.deployment}:mymemo:turn`,
		options,
	);
}
