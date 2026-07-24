import { type AGUIEvent, EventType } from "@ag-ui/core";
import { AssistantEnvelopeProtocolError } from "./assistant-message-assembler";

const DEFAULT_COALESCE_WINDOW_MS = 50;
const MAX_PENDING_TEXT_LENGTH = 16_384;

/**
 * Coalesces provider text fragments into sequential Live Stream appends.
 * At most one Redis append is in flight; backpressure is applied once the
 * bounded pending buffer fills, and `flushMessage` drains all text before the
 * caller commits the Assistant message and publishes TEXT_MESSAGE_END.
 */
export class AgUiTextStream {
	readonly #appendEvent: (event: AGUIEvent) => Promise<void>;
	readonly #coalesceWindowMs: number;
	#messageId: string | null = null;
	#pendingText = "";
	#timer: ReturnType<typeof setTimeout> | null = null;
	#inFlight: Promise<void> | null = null;
	#failure: { error: unknown } | null = null;

	constructor(input: {
		appendEvent: (event: AGUIEvent) => Promise<void>;
		coalesceWindowMs?: number;
	}) {
		this.#appendEvent = input.appendEvent;
		this.#coalesceWindowMs =
			input.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
	}

	get messageId(): string | null {
		return this.#messageId;
	}

	async append(messageId: string, text: string): Promise<void> {
		if (this.#messageId === null) {
			this.#messageId = messageId;
			await this.#appendEvent({
				type: EventType.TEXT_MESSAGE_START,
				messageId,
				role: "assistant",
			});
		}
		if (this.#messageId !== messageId) {
			throw new AssistantEnvelopeProtocolError(
				"Assistant message identity changed before message_stop",
			);
		}

		this.#pendingText += text;
		if (this.#pendingText.length >= MAX_PENDING_TEXT_LENGTH) {
			this.#clearTimer();
			await this.#drain();
			return;
		}
		this.#schedule();
	}

	/** Drains the open message and returns its id for TEXT_MESSAGE_END. */
	async flushMessage(): Promise<string | null> {
		const messageId = this.#messageId;
		this.#clearTimer();
		await this.#drain();
		this.#messageId = null;
		this.#failure = null;
		return messageId;
	}

	async abandon(): Promise<void> {
		this.#clearTimer();
		this.#pendingText = "";
		if (this.#inFlight !== null) {
			try {
				await this.#inFlight;
			} catch {
				// The bound producer already degrades Redis failures to telemetry.
			}
		}
		this.#messageId = null;
		this.#failure = null;
	}

	#schedule(): void {
		if (
			this.#timer !== null ||
			this.#pendingText.length === 0 ||
			this.#inFlight !== null
		) {
			return;
		}
		this.#timer = setTimeout(() => {
			this.#timer = null;
			this.#startPublication();
		}, this.#coalesceWindowMs);
	}

	#startPublication(): void {
		if (this.#inFlight !== null || this.#pendingText.length === 0) return;
		const messageId = this.#messageId;
		if (messageId === null) return;
		this.#clearTimer();

		const delta = this.#pendingText;
		this.#pendingText = "";
		const publication = this.#appendEvent({
			type: EventType.TEXT_MESSAGE_CONTENT,
			messageId,
			delta,
		});
		this.#inFlight = publication;
		void publication.then(
			() => this.#publicationSettled(publication),
			(error: unknown) => {
				this.#failure ??= { error };
				this.#publicationSettled(publication);
			},
		);
	}

	#publicationSettled(publication: Promise<void>): void {
		if (this.#inFlight !== publication) return;
		this.#inFlight = null;
		this.#schedule();
	}

	async #drain(): Promise<void> {
		while (true) {
			if (this.#failure !== null) throw this.#failure.error;
			if (this.#inFlight !== null) {
				try {
					await this.#inFlight;
				} catch {
					// The rejection handler records the original failure for this loop.
				}
				continue;
			}
			if (this.#pendingText.length === 0) return;
			this.#startPublication();
		}
	}

	#clearTimer(): void {
		if (this.#timer === null) return;
		clearTimeout(this.#timer);
		this.#timer = null;
	}
}
