import {
	LIVE_TEXT_MAX_CHUNK_LENGTH,
	type LiveTextPublisher,
} from "@mymemo/live-text";

export const LIVE_TEXT_COALESCE_WINDOW_MS = 50;
export const LIVE_TEXT_MAX_QUEUED_MESSAGES = 32;

export type LiveTextPreviewDropReason =
	| "mismatch"
	| "publisher_failure"
	| "queue_overflow"
	| "run_aborted"
	| "run_ended";

export type LiveTextPreviewSignal =
	| { type: "attempted" }
	| { type: "delivered" }
	| { type: "dropped"; reason: LiveTextPreviewDropReason }
	| {
			type: "recovered";
			reason: "publisher_failure" | "queue_overflow";
	  };

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
	readonly #attemptedMessageIds = new Set<string>();
	readonly #completedMessageIds = new Set<string>();
	readonly #resolvedMessageIds = new Set<string>();
	#messageId: string | null = null;
	#deltaIndex = 0;
	#pendingText = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#publishing = false;
	#publishController: AbortController | undefined;
	#inFlightMessageId: string | null = null;
	#degradedReason: "publisher_failure" | "queue_overflow" | undefined;
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
		if (!this.#attemptedMessageIds.has(messageId)) {
			this.#attemptedMessageIds.add(messageId);
			this.#emitSignal({ type: "attempted" });
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
		if (completedMessageId !== null) {
			this.#completedMessageIds.add(completedMessageId);
			this.#maybeMarkDelivered(completedMessageId);
		}
		if (
			completedMessageId !== null &&
			this.#inFlightMessageId !== completedMessageId
		) {
			this.#failedMessageIds.delete(completedMessageId);
		}
	}

	disable(reason: LiveTextPreviewDropReason = "mismatch"): void {
		this.#disabled = true;
		this.#discardAll(reason);
	}

	abandon(): void {
		this.#discardAll("run_aborted");
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#discardAll("run_ended");
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
						this.#degradedReason !== undefined
					) {
						const reason = this.#degradedReason;
						this.#degradedReason = undefined;
						this.#emitSignal({ type: "recovered", reason });
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
				this.#maybeMarkDelivered(next.messageId);
				this.#pump();
			});
	}

	#failMessage(
		messageId: string,
		reason: "publisher_failure" | "queue_overflow",
	): void {
		if (this.#failedMessageIds.has(messageId)) return;
		this.#failedMessageIds.add(messageId);
		this.#degradedReason = reason;
		if (this.#messageId === messageId) this.#pendingText = "";
		this.#discardQueuedMessage(messageId);
		this.#markDropped(messageId, reason);
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

	#discardAll(reason: LiveTextPreviewDropReason): void {
		this.#clearTimer();
		this.#pendingText = "";
		this.#queue.length = 0;
		this.#publishController?.abort();
		this.#messageId = null;
		this.#deltaIndex = 0;
		for (const messageId of this.#attemptedMessageIds) {
			this.#markDropped(messageId, reason);
		}
	}

	#maybeMarkDelivered(messageId: string): void {
		if (
			!this.#completedMessageIds.has(messageId) ||
			this.#failedMessageIds.has(messageId) ||
			this.#resolvedMessageIds.has(messageId) ||
			this.#inFlightMessageId === messageId ||
			this.#queue.some((queued) => queued.messageId === messageId)
		) {
			return;
		}
		this.#resolvedMessageIds.add(messageId);
		this.#emitSignal({ type: "delivered" });
	}

	#markDropped(messageId: string, reason: LiveTextPreviewDropReason): void {
		if (
			!this.#attemptedMessageIds.has(messageId) ||
			this.#resolvedMessageIds.has(messageId)
		) {
			return;
		}
		this.#resolvedMessageIds.add(messageId);
		this.#emitSignal({ type: "dropped", reason });
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
