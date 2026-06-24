import { describe, expect, it } from "bun:test";
import { SSEStreamingApi } from "hono/streaming";
import { HonoSSESender } from "./chat.streaming";

describe("HonoSSESender", () => {
	it("preserves wire order when send and sendPing are interleaved without awaits", async () => {
		// Simulates the keepalive setInterval firing between two send() calls
		// in the conversation event route. With current hono (4.12.12) the WritableStream
		// queue plus microtask FIFO keep frames in invocation order even
		// though sendPing is fire-and-forget in production. If hono ever adds
		// async work before its writer.write() enqueue, this test will fail
		// and HonoSSESender will need an internal serialization queue.
		const { readable, writable } = new TransformStream<Uint8Array>();
		const stream = new SSEStreamingApi(writable, readable);
		const sender = new HonoSSESender(stream);

		const reader = stream.responseReadable.getReader();
		const decoder = new TextDecoder();
		let buf = "";
		const readAll = (async () => {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += decoder.decode(value, { stream: true });
			}
		})();

		const writes = [
			sender.send({
				id: "a",
				message: { type: "text_delta", text: "first" },
			}),
			sender.sendPing(),
			sender.send({
				id: "b",
				message: { type: "text_delta", text: "second" },
			}),
			sender.sendPing(),
			sender.send({
				id: "c",
				message: { type: "text_delta", text: "third" },
			}),
		];
		await Promise.all(writes);
		await stream.close();
		await readAll;

		const events = Array.from(buf.matchAll(/event: (\S+)/g)).map((m) => m[1]);
		expect(events).toEqual([
			"text_delta",
			"ping",
			"text_delta",
			"ping",
			"text_delta",
		]);
	});
});
