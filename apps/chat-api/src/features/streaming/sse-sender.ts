import type { SSEStreamingApi } from "hono/streaming";
import type { MymemoEvent } from "./events";

export interface Sender<T> {
	send(data: T): Promise<void>;
}

export interface MymemoEventSender extends Sender<MymemoEvent> {
	sendPing(): Promise<void>;
}

// Wire order between concurrent send / sendPing calls is load-bearing on
// hono's writeSSE doing its `writer.write()` enqueue in the first microtask
// after the call (no async work between the sync string build and the
// enqueue). Today (hono 4.12.12) that holds, and microtask FIFO + the
// WritableStream's FIFO queue keep frames in invocation order even though
// the keepalive setInterval doesn't await its sendPing. If hono ever adds
// real async work before the enqueue in writeSSE, this class will need an
// internal serialization queue. The `interleaved order` test in
// sse-sender.test.ts pins this behavior.
export class HonoSSESender implements MymemoEventSender {
	constructor(private stream: SSEStreamingApi) {}

	async send(data: MymemoEvent) {
		await this.stream.writeSSE({
			data: JSON.stringify(data.message),
			event: data.message.type,
			id: data.id,
		});
	}

	async sendPing() {
		await this.stream.writeSSE({
			data: JSON.stringify({}),
			event: "ping",
			id: crypto.randomUUID(),
		});
	}
}
