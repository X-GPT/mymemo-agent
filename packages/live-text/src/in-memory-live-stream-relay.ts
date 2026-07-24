import {
	type LiveStreamRelay,
	type LiveStreamRelayOptions,
	type LiveStreamRelayTransport,
	ProducerBufferedLiveStreamRelay,
} from "./live-stream-relay";

class InMemoryRelayTransport implements LiveStreamRelayTransport {
	readonly #subscribers = new Map<string, Set<(message: string) => void>>();
	#closed = false;

	async publish(channel: string, message: string): Promise<void> {
		if (this.#closed) throw new Error("Live Stream relay is closed");
		for (const subscriber of this.#subscribers.get(channel) ?? []) {
			subscriber(message);
		}
	}

	async subscribe(
		channel: string,
		onMessage: (message: string) => void,
	): Promise<{ close(): Promise<void> }> {
		if (this.#closed) throw new Error("Live Stream relay is closed");
		const subscribers = this.#subscribers.get(channel) ?? new Set();
		subscribers.add(onMessage);
		this.#subscribers.set(channel, subscribers);
		let closed = false;
		return {
			close: async () => {
				if (closed) return;
				closed = true;
				subscribers.delete(onMessage);
				if (subscribers.size === 0) this.#subscribers.delete(channel);
			},
		};
	}

	async close(): Promise<void> {
		this.#closed = true;
		this.#subscribers.clear();
	}
}

export function createInMemoryLiveStreamRelay(
	options: LiveStreamRelayOptions = {},
): LiveStreamRelay {
	return new ProducerBufferedLiveStreamRelay(
		new InMemoryRelayTransport(),
		"memory:mymemo:agui",
		options,
	);
}
