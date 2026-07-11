import { z } from "zod";

export const LIVE_TEXT_MAX_CHUNK_LENGTH = 16_384;
const LIVE_TEXT_MAX_ID_LENGTH = 128;

export const LiveTextMessageSchema = z
	.object({
		runId: z.string().min(1).max(LIVE_TEXT_MAX_ID_LENGTH),
		messageId: z.string().min(1).max(LIVE_TEXT_MAX_ID_LENGTH),
		deltaIndex: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
		text: z.string().min(1).max(LIVE_TEXT_MAX_CHUNK_LENGTH),
	})
	.strict();

export type LiveTextMessage = z.infer<typeof LiveTextMessageSchema>;

export interface LiveTextPublisher {
	publish(message: LiveTextMessage): Promise<void>;
}

export interface LiveTextSubscription {
	readAvailable(): LiveTextMessage[];
	waitForMessage(options?: {
		timeoutMs?: number;
		signal?: AbortSignal;
	}): Promise<boolean>;
	close(): Promise<void>;
}

export interface LiveTextSubscriber {
	subscribe(runId: string): Promise<LiveTextSubscription>;
}

class InMemoryLiveTextSubscription implements LiveTextSubscription {
	readonly #buffer: LiveTextMessage[] = [];
	readonly #waiters = new Set<(available: boolean) => void>();
	#closed = false;

	constructor(
		readonly runId: string,
		private readonly maxBufferedMessages: number,
		private readonly onClose: () => void,
	) {}

	enqueue(message: LiveTextMessage): void {
		if (this.#closed || this.#buffer.length >= this.maxBufferedMessages) return;
		this.#buffer.push(message);
		for (const wake of this.#waiters) wake(true);
		this.#waiters.clear();
	}

	readAvailable(): LiveTextMessage[] {
		if (this.#closed) return [];
		return this.#buffer.splice(0);
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
		for (const wake of this.#waiters) wake(false);
		this.#waiters.clear();
		this.onClose();
	}
}

/** Deterministic process-local transport used by integration tests. */
export class InMemoryLiveTextTransport
	implements LiveTextPublisher, LiveTextSubscriber
{
	readonly #subscriptions = new Map<
		string,
		Set<InMemoryLiveTextSubscription>
	>();

	constructor(private readonly maxBufferedMessages = 64) {
		if (!Number.isSafeInteger(maxBufferedMessages) || maxBufferedMessages < 1) {
			throw new Error("maxBufferedMessages must be a positive integer");
		}
	}

	async publish(message: LiveTextMessage): Promise<void> {
		const parsed = LiveTextMessageSchema.parse(message);
		for (const subscription of this.#subscriptions.get(parsed.runId) ?? []) {
			subscription.enqueue(parsed);
		}
	}

	async subscribe(runId: string): Promise<LiveTextSubscription> {
		const parsedRunId = LiveTextMessageSchema.shape.runId.parse(runId);
		const subscriptions = this.#subscriptions.get(parsedRunId) ?? new Set();
		this.#subscriptions.set(parsedRunId, subscriptions);
		let subscription: InMemoryLiveTextSubscription;
		subscription = new InMemoryLiveTextSubscription(
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
}

export const disabledLiveTextSubscriber: LiveTextSubscriber = {
	async subscribe() {
		throw new Error("Live text is disabled");
	},
};

export const disabledLiveTextPublisher: LiveTextPublisher = {
	async publish() {},
};
