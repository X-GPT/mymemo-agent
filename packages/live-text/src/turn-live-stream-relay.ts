import { z } from "zod";
import { createInMemoryRelayTransport } from "./in-memory-live-stream-relay";
import {
	LIVE_STREAM_MAX_EVENT_BYTES,
	LiveStreamRelayError,
} from "./live-stream-events";
import { AsyncQueue, type LiveStreamRelayTransport } from "./live-stream-relay";
import {
	validateLiveStreamDeployment,
	validateLiveStreamTurnId,
} from "./live-stream-validation";
import {
	createRedisRelayTransport,
	type RedisRelayTransportOptions,
} from "./redis-live-stream-relay";

/**
 * The v2 Live Stream lane (spec #654): a Turn's UIMessage events published
 * over the payload-agnostic relay transport on a per-Turn channel. Pure
 * pub/sub — deliberately no producer-buffered backlog and no request/reply
 * re-attach. The Live Stream dies with its Turn; a late or disconnected
 * subscriber recovers from durable history, never from this lane.
 */

export const TURN_OUTCOMES = ["done", "error", "interrupted"] as const;
export type TurnOutcome = (typeof TURN_OUTCOMES)[number];

/** The Turn's terminal event on the Live Stream. Publish-side only via
 * `publishOutcome`; a UIMessage chunk may not claim this type. */
export const TURN_OUTCOME_EVENT_TYPE = "turn-outcome" as const;
const TURN_RELAY_FAILED_EVENT_TYPE = "turn-relay-failed" as const;

const TurnOutcomeEventSchema = z
	.object({
		type: z.literal(TURN_OUTCOME_EVENT_TYPE),
		outcome: z.enum(TURN_OUTCOMES),
	})
	.strict();

export type TurnOutcomeEvent = z.infer<typeof TurnOutcomeEventSchema>;

/** Recognize the Turn's Outcome event among subscribed Live Stream events. */
export function parseTurnOutcomeEvent(
	chunk: Uint8Array,
): TurnOutcomeEvent | undefined {
	try {
		return TurnOutcomeEventSchema.parse(
			JSON.parse(EVENT_DECODER.decode(chunk)),
		);
	} catch {
		return undefined;
	}
}

export interface TurnLiveStreamPublisher {
	/** Publish one serialized UIMessage chunk (a JSON object with a string
	 * `type`). Oversize or malformed chunks are rejected without failing the
	 * stream. */
	publish(chunk: Uint8Array): Promise<void>;
	/** Publish the Turn's Outcome event — the stream's single terminal. */
	publishOutcome(outcome: TurnOutcome): Promise<void>;
	close(): Promise<void>;
}

export interface TurnLiveStreamRelay {
	openPublisher(turnId: string): TurnLiveStreamPublisher;
	/** Subscribe to a Turn's live events. Delivery starts at subscription
	 * time — there is no backlog; earlier events are simply missed. The
	 * iteration ends after the Outcome event, or when `signal` aborts. */
	subscribe(
		turnId: string,
		signal: AbortSignal,
	): Promise<AsyncIterable<Uint8Array>>;
	close(): Promise<void>;
}

export interface TurnLiveStreamRelayOptions {
	testHooks?: {
		failPublishWhen?: (chunkType: string) => boolean;
	};
}

const EVENT_ENCODER = new TextEncoder();
const EVENT_DECODER = new TextDecoder("utf-8", { fatal: true });

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

	openPublisher(turnId: string): TurnLiveStreamPublisher {
		this.#assertOpen();
		validateLiveStreamTurnId(turnId);
		const publisher = new TransportTurnLiveStreamPublisher(
			this.#transport,
			this.#channel(turnId),
			this.#testHooks,
			() => this.#publishers.delete(publisher),
		);
		this.#publishers.add(publisher);
		return publisher;
	}

	async subscribe(
		turnId: string,
		signal: AbortSignal,
	): Promise<AsyncIterable<Uint8Array>> {
		this.#assertOpen();
		validateLiveStreamTurnId(turnId);
		const queue = new AsyncQueue<Uint8Array>();
		if (signal.aborted) {
			queue.end();
			return queue.iterate(async () => {});
		}
		const subscription = await this.#transport.subscribe(
			this.#channel(turnId),
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
				queue.push(EVENT_ENCODER.encode(message));
				if (type === TURN_OUTCOME_EVENT_TYPE) queue.end();
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

	#channel(turnId: string): string {
		return `${this.#channelPrefix}:{${turnId}}:live`;
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
	#outcomePublished = false;

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

	async publish(chunk: Uint8Array): Promise<void> {
		const chunkType = parseUiMessageChunkType(chunk);
		if (chunk.byteLength > LIVE_STREAM_MAX_EVENT_BYTES) {
			throw new LiveStreamRelayError("event_too_large");
		}
		return this.#publish(EVENT_DECODER.decode(chunk), chunkType);
	}

	publishOutcome(outcome: TurnOutcome): Promise<void> {
		return this.#publish(
			JSON.stringify({ type: TURN_OUTCOME_EVENT_TYPE, outcome }),
			TURN_OUTCOME_EVENT_TYPE,
		);
	}

	#publish(serialized: string, chunkType: string): Promise<void> {
		const publish = this.#publishTail.then(async () => {
			if (this.#closed) throw new LiveStreamRelayError("producer_closed");
			if (this.#failed) throw new LiveStreamRelayError("producer_failed");
			if (this.#outcomePublished) {
				throw new LiveStreamRelayError("terminal_already_published");
			}
			try {
				if (this.#testHooks?.failPublishWhen?.(chunkType)) {
					throw new Error("injected Turn Live Stream publish failure");
				}
				await this.#transport.publish(this.#channel, serialized);
			} catch {
				this.#fail();
				throw new LiveStreamRelayError("relay_failed");
			}
			if (chunkType === TURN_OUTCOME_EVENT_TYPE) {
				this.#outcomePublished = true;
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
		if (!this.#outcomePublished && !this.#failed) this.#fail();
		this.#closed = true;
		await this.#publishTail;
		this.#onClose();
	}
}

/** A publishable UIMessage chunk is a JSON object with a non-empty string
 * `type` that does not claim one of this lane's reserved control types. */
function parseUiMessageChunkType(chunk: Uint8Array): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(EVENT_DECODER.decode(chunk));
	} catch {
		throw new LiveStreamRelayError("invalid_event");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("type" in parsed) ||
		typeof parsed.type !== "string" ||
		parsed.type.length === 0 ||
		parsed.type === TURN_OUTCOME_EVENT_TYPE ||
		parsed.type === TURN_RELAY_FAILED_EVENT_TYPE
	) {
		throw new LiveStreamRelayError("invalid_event");
	}
	return parsed.type;
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
