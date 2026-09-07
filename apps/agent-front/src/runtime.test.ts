import { expect, test } from "bun:test";
import { sdkMessages } from "./runtime";

test("NDJSON preserves split UTF-8 and accepts a final line without a newline", async () => {
	const bytes = new TextEncoder().encode(
		'\n{"text":"你好"}\n{"type":"result"}',
	);
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
			controller.close();
		},
	});
	const messages = [];
	for await (const message of sdkMessages(stream)) messages.push(message);
	expect(messages).toEqual([{ text: "你好" }, { type: "result" }]);
});

test("a malformed Runtime line rejects instead of reporting a completed Turn", async () => {
	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"type":'));
			controller.close();
		},
	});
	await expect(sdkMessages(stream).next()).rejects.toBeInstanceOf(SyntaxError);
});
