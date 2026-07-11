import {
	LIVE_TEXT_MAX_CHUNK_LENGTH,
	type LiveTextPublisher,
} from "@mymemo/live-text";

export const LIVE_TEXT_COALESCE_WINDOW_MS = 50;
export const LIVE_TEXT_MAX_QUEUED_MESSAGES = 32;

export type LiveTextPreviewSignal =
	| "publisher_failure"
	| "queue_overflow"
	| "recovered";

interface QueuedPreview {
	messageId: string;
	deltaIndex: number;
	text: string;
}

export class LiveTextPreview {
	readonly #runId: string;
	readonly #publisher: LiveTextPublisher;
	readonly #coalesceWindowMs: number;
	readonly #maxQueuedMessages: number;
	readonly #onSignal?: (signal: LiveTextPreviewSignal) => void;
	readonly #queue: QueuedPreview[] = [];
	readonly #failedMessageIds = new Set<string>();
	#messageId: string | null = null;
	#deltaIndex = 0;
	#pendingText = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#publishing = false;
	#publishController: AbortController | undefined;
	#inFlightMessageId: string | null = null;
	#degraded = false;
	#disabled = false;
	#closed = false;

	constructor(options: {
		runId: string;
		publisher: LiveTextPublisher;
		coalesceWindowMs?: number;
		maxQueuedMessages?: number;
		onSignal?: (signal: LiveTextPreviewSignal) => void;
	}) {
		this.#runId = options.runId;
		this.#publisher = options.publisher;
		this.#coalesceWindowMs =
			options.coalesceWindowMs ?? LIVE_TEXT_COALESCE_WINDOW_MS;
		this.#maxQueuedMessages =
			options.maxQueuedMessages ?? LIVE_TEXT_MAX_QUEUED_MESSAGES;
		this.#onSignal = options.onSignal;
		if (
			this.#coalesceWindowMs < 0 ||
			this.#coalesceWindowMs > LIVE_TEXT_COALESCE_WINDOW_MS
		) {
			throw new Error("Live text coalescing must be between 0 and 50 ms");
		}
		if (
			!Number.isSafeInteger(this.#maxQueuedMessages) ||
			this.#maxQueuedMessages < 1
		) {
			throw new Error("Live text queue bound must be a positive integer");
		}
	}

	append(messageId: string, text: string): void {
		if (
			this.#closed ||
			this.#disabled ||
			this.#failedMessageIds.has(messageId) ||
			text.length === 0
		)
			return;
		if (this.#messageId !== null && this.#messageId !== messageId) {
			throw new Error("Live text message changed before message_stop");
		}
		this.#messageId = messageId;
		this.#pendingText += text;
		while (this.#pendingText.length >= LIVE_TEXT_MAX_CHUNK_LENGTH) {
			this.#enqueue(this.#pendingText.slice(0, LIVE_TEXT_MAX_CHUNK_LENGTH));
			this.#pendingText = this.#pendingText.slice(LIVE_TEXT_MAX_CHUNK_LENGTH);
		}
		if (this.#pendingText.length > 0 && this.#timer === undefined) {
			this.#timer = setTimeout(() => {
				this.#timer = undefined;
				this.#enqueuePending();
			}, this.#coalesceWindowMs);
		}
	}

	async flushMessage(): Promise<void> {
		this.#clearTimer();
		this.#enqueuePending();
		const completedMessageId = this.#messageId;
		this.#messageId = null;
		this.#deltaIndex = 0;
		if (
			completedMessageId !== null &&
			this.#inFlightMessageId !== completedMessageId
		) {
			this.#failedMessageIds.delete(completedMessageId);
		}
	}

	disable(): void {
		this.#disabled = true;
		this.#discardAll();
	}

	abandon(): void {
		this.#clearTimer();
		this.#pendingText = "";
		const messageId = this.#messageId;
		if (messageId !== null) {
			this.#failedMessageIds.add(messageId);
			this.#discardQueuedMessage(messageId);
			if (this.#inFlightMessageId === messageId) {
				this.#publishController?.abort();
			}
		}
		this.#messageId = null;
		this.#deltaIndex = 0;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#discardAll();
		this.#failedMessageIds.clear();
	}

	#enqueuePending(): void {
		if (this.#pendingText.length === 0) return;
		const text = this.#pendingText;
		this.#pendingText = "";
		this.#enqueue(text);
	}

	#enqueue(text: string): void {
		const messageId = this.#messageId;
		if (
			this.#closed ||
			this.#disabled ||
			messageId === null ||
			this.#failedMessageIds.has(messageId) ||
			text.length === 0
		)
			return;
		const deltaIndex = this.#deltaIndex++;
		if (this.#queue.length >= this.#maxQueuedMessages) {
			this.#failMessage(messageId, "queue_overflow");
			return;
		}
		this.#queue.push({ messageId, deltaIndex, text });
		this.#pump();
	}

	#pump(): void {
		if (this.#closed || this.#disabled || this.#publishing) return;
		const next = this.#queue.shift();
		if (!next) return;
		if (this.#failedMessageIds.has(next.messageId)) {
			this.#pump();
			return;
		}

		this.#publishing = true;
		this.#inFlightMessageId = next.messageId;
		const controller = new AbortController();
		this.#publishController = controller;
		let publication: Promise<void>;
		try {
			publication = this.#publisher.publish(
				{ runId: this.#runId, ...next },
				{ signal: controller.signal },
			);
		} catch {
			publication = Promise.reject(new Error("Live text publisher threw"));
		}
		void publication
			.then(
				() => {
					if (
						!controller.signal.aborted &&
						!this.#failedMessageIds.has(next.messageId) &&
						this.#degraded
					) {
						this.#degraded = false;
						this.#emitSignal("recovered");
					}
				},
				() => {
					if (!controller.signal.aborted) {
						this.#failMessage(next.messageId, "publisher_failure");
					}
				},
			)
			.finally(() => {
				this.#publishing = false;
				this.#inFlightMessageId = null;
				if (this.#publishController === controller) {
					this.#publishController = undefined;
				}
				if (this.#messageId !== next.messageId) {
					this.#failedMessageIds.delete(next.messageId);
				}
				this.#pump();
			});
	}

	#failMessage(messageId: string, signal: LiveTextPreviewSignal): void {
		if (this.#failedMessageIds.has(messageId)) return;
		this.#failedMessageIds.add(messageId);
		this.#degraded = true;
		if (this.#messageId === messageId) this.#pendingText = "";
		this.#discardQueuedMessage(messageId);
		this.#emitSignal(signal);
	}

	#emitSignal(signal: LiveTextPreviewSignal): void {
		try {
			this.#onSignal?.(signal);
		} catch {
			// Telemetry is optional and cannot change the Run outcome.
		}
	}

	#discardQueuedMessage(messageId: string): void {
		for (let index = this.#queue.length - 1; index >= 0; index--) {
			if (this.#queue[index]?.messageId === messageId) {
				this.#queue.splice(index, 1);
			}
		}
	}

	#discardAll(): void {
		this.#clearTimer();
		this.#pendingText = "";
		this.#queue.length = 0;
		this.#publishController?.abort();
		this.#messageId = null;
		this.#deltaIndex = 0;
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
