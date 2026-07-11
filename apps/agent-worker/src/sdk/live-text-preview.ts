import {
	LIVE_TEXT_MAX_CHUNK_LENGTH,
	type LiveTextPublisher,
} from "@mymemo/live-text";

export const LIVE_TEXT_COALESCE_WINDOW_MS = 50;

export class LiveTextPreview {
	readonly #runId: string;
	readonly #publisher: LiveTextPublisher;
	readonly #coalesceWindowMs: number;
	#messageId: string | null = null;
	#deltaIndex = 0;
	#pendingText = "";
	#timer: ReturnType<typeof setTimeout> | undefined;
	#publishChain: Promise<void> = Promise.resolve();
	#failedMessageId: string | null = null;
	#disabled = false;

	constructor(options: {
		runId: string;
		publisher: LiveTextPublisher;
		coalesceWindowMs?: number;
	}) {
		this.#runId = options.runId;
		this.#publisher = options.publisher;
		this.#coalesceWindowMs =
			options.coalesceWindowMs ?? LIVE_TEXT_COALESCE_WINDOW_MS;
		if (
			this.#coalesceWindowMs < 0 ||
			this.#coalesceWindowMs > LIVE_TEXT_COALESCE_WINDOW_MS
		) {
			throw new Error("Live text coalescing must be between 0 and 50 ms");
		}
	}

	append(messageId: string, text: string): void {
		if (
			this.#disabled ||
			this.#failedMessageId === messageId ||
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
		await this.#publishChain;
		this.#messageId = null;
		this.#deltaIndex = 0;
		this.#failedMessageId = null;
	}

	disable(): void {
		this.abandon();
		this.#disabled = true;
	}

	abandon(): void {
		this.#clearTimer();
		this.#pendingText = "";
		this.#failedMessageId = this.#messageId;
		this.#messageId = null;
		this.#deltaIndex = 0;
	}

	#enqueuePending(): void {
		if (this.#pendingText.length === 0) return;
		const text = this.#pendingText;
		this.#pendingText = "";
		this.#enqueue(text);
	}

	#enqueue(text: string): void {
		const messageId = this.#messageId;
		if (this.#disabled || messageId === null || text.length === 0) return;
		const deltaIndex = this.#deltaIndex++;
		this.#publishChain = this.#publishChain.then(async () => {
			if (this.#disabled || this.#failedMessageId === messageId) return;
			try {
				await this.#publisher.publish({
					runId: this.#runId,
					messageId,
					deltaIndex,
					text,
				});
			} catch {
				// Preview is optional. A transport failure must never fail the Run.
				this.#failedMessageId = messageId;
			}
		});
	}

	#clearTimer(): void {
		if (this.#timer === undefined) return;
		clearTimeout(this.#timer);
		this.#timer = undefined;
	}
}
