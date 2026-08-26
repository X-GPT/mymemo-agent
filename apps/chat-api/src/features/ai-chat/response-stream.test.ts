import { expect, it } from "bun:test";
import { toAiSdkResponse } from "./response-stream";

const successfulClaudeStream = [
	{
		type: "stream_event",
		event: {
			type: "content_block_delta",
			delta: { type: "text_delta", text: "Hello" },
		},
	},
	{
		type: "result",
		subtype: "success",
		is_error: false,
		session_id: "session-1",
	},
]
	.map((message) => JSON.stringify(message))
	.join("\n");

function upstream(body = `${successfulClaudeStream}\n`) {
	return new Response(body, {
		headers: { "content-type": "application/x-ndjson" },
	});
}

it("maps raw Claude SDK messages and persists before AI SDK completion", async () => {
	const completed: unknown[] = [];
	const response = toAiSdkResponse(upstream(), async (message) => {
		completed.push(message);
	});

	expect(response.headers.get("content-type")).toBe("text/event-stream");
	expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
	const body = await response.text();
	expect(body).toContain('"type":"text-delta"');
	expect(body).toEndWith("data: [DONE]\n\n");
	expect(completed).toEqual([
		{
			messageId: expect.any(String),
			parts: [{ type: "text", text: "Hello", state: "done" }],
		},
	]);
});

it("does not complete an invalid or truncated Claude stream", async () => {
	for (const response of [
		upstream('{"type":"unknown"}\n'),
		upstream(successfulClaudeStream),
	]) {
		await expect(
			toAiSdkResponse(response, async () => {}).text(),
		).rejects.toThrow();
	}
	await expect(
		toAiSdkResponse(upstream(), async () => {
			throw new Error("database unavailable");
		}).text(),
	).rejects.toThrow("database unavailable");
});

it("keeps draining and persists after the client disconnects", async () => {
	const lines = successfulClaudeStream.split("\n");
	const terminal = lines.pop();
	let runtime: ReadableStreamDefaultController<Uint8Array> | undefined;
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			runtime = controller;
			controller.enqueue(new TextEncoder().encode(`${lines.join("\n")}\n`));
		},
	});
	let persisted = () => {};
	const didPersist = new Promise<void>((resolve) => {
		persisted = resolve;
	});
	const response = toAiSdkResponse(
		new Response(body, {
			headers: { "content-type": "application/x-ndjson" },
		}),
		async () => persisted(),
	);
	const client = response.body?.getReader();
	await client?.read();
	await client?.cancel();
	runtime?.enqueue(new TextEncoder().encode(`${terminal}\n`));
	runtime?.close();
	await didPersist;
});
