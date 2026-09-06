import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { query, type SDKMessage } from "claude-agent-sdk";
import { createRuntimeServer, invocationSchema } from "./runtime";

const require = createRequire(import.meta.url);
const executable = require.resolve(
	`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`,
	{
		paths: [dirname(require.resolve("claude-agent-sdk"))],
	},
);
const payload = () => ({
	conversationId: crypto.randomUUID(),
	turnId: crypto.randomUUID(),
	seq: 1,
	requestId: "request",
	userId: "user",
	scope: { kind: "general" },
	text: "Say hi",
	startedAt: Date.now(),
	budgetUntil: Date.now() + 720_000,
	sandboxSessionId: "sandbox",
});

// Adapted from #730's sdk-session-probe fake Anthropic Messages server.
function fakeMessages(tool: boolean) {
	const events: string[] = [];
	const emit = (type: string, data: object) =>
		events.push(
			`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
		);
	emit("message_start", {
		message: {
			id: "msg_fake",
			type: "message",
			role: "assistant",
			model: "fake",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 10, output_tokens: 0 },
		},
	});
	const blocks = tool
		? [{ type: "tool_use", id: "tool_fake", name: "Bash", input: {} }]
		: [
				{ type: "thinking", thinking: "", signature: "" },
				{ type: "text", text: "" },
			];
	for (const [index, block] of blocks.entries()) {
		emit("content_block_start", { index, content_block: block });
		if (tool)
			emit("content_block_delta", {
				index,
				delta: {
					type: "input_json_delta",
					partial_json: '{"command":"touch /tmp/mymemo-should-not-execute"}',
				},
			});
		else if (index === 0) {
			emit("content_block_delta", {
				index,
				delta: { type: "thinking_delta", thinking: "I should greet the user." },
			});
			emit("content_block_delta", {
				index,
				delta: { type: "signature_delta", signature: "fake-signature" },
			});
		} else
			emit("content_block_delta", {
				index,
				delta: { type: "text_delta", text: "Hello from fake model." },
			});
		emit("content_block_stop", { index });
	}
	emit("message_delta", {
		delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null },
		usage: { output_tokens: 10 },
	});
	emit("message_stop", {});
	return events.join("");
}

async function harness(mode: "normal" | "budget" | "disconnect" | "throw") {
	const cwd = await mkdtemp(join(tmpdir(), "runtime-test-"));
	const captured: SDKMessage[] = [];
	let configDir = "";
	let modelCalls = 0;
	const fake = Bun.serve({
		port: 0,
		async fetch(request) {
			if (!new URL(request.url).pathname.endsWith("/messages"))
				return new Response("{}", { status: 404 });
			const body = (await request.json()) as { tools?: unknown[] };
			expect(body.tools ?? []).toEqual([]);
			modelCalls++;
			if (mode === "budget" || mode === "disconnect")
				return new Response(new ReadableStream({}), {
					headers: { "content-type": "text/event-stream" },
				});
			return new Response(fakeMessages(modelCalls === 1), {
				headers: { "content-type": "text/event-stream" },
			});
		},
	});
	const server = createRuntimeServer(
		{
			cwd,
			model: "fake",
			pathToClaudeCodeExecutable: executable,
			env: {
				...process.env,
				ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.port}`,
				ANTHROPIC_AUTH_TOKEN: "fake-token",
				ANTHROPIC_API_KEY: "",
			},
		},
		(params) => {
			configDir = params.options?.env?.CLAUDE_CONFIG_DIR ?? "";
			expect(params.options?.tools).toEqual([]);
			expect(params.options?.permissionMode).toBe("dontAsk");
			expect(params.options?.settingSources).toEqual([]);
			if (mode === "throw") throw new Error("injected failure");
			const active = query(params);
			const iterator = active[Symbol.asyncIterator].bind(active);
			active[Symbol.asyncIterator] = async function* () {
				for await (const message of { [Symbol.asyncIterator]: iterator }) {
					captured.push(message);
					yield message;
				}
			};
			return active;
		},
	);
	return {
		url: `http://127.0.0.1:${server.port}`,
		captured,
		async cleanup() {
			await server.stop(true);
			fake.stop(true);
			await rm(cwd, { recursive: true, force: true });
		},
		async checkRemoved() {
			for (
				let i = 0;
				i < 100 &&
				(await readdir(tmpdir())).includes(configDir.split("/").at(-1) ?? "");
				i++
			)
				await Bun.sleep(100);
			expect(
				(await readdir(tmpdir())).includes(configDir.split("/").at(-1) ?? ""),
			).toBe(false);
		},
	};
}

for (const mode of ["normal", "budget", "disconnect", "throw"] as const) {
	test(`real SDK: ${mode}`, async () => {
		const h = await harness(mode);
		try {
			const input = payload();
			if (mode === "budget") input.budgetUntil = Date.now() + 123_000;
			if (mode === "disconnect") {
				await new Promise<void>((resolve, reject) => {
					const req = httpRequest(
						`${h.url}/invocations`,
						{ method: "POST" },
						(res) => {
							res.once("data", () => {
								res.destroy();
								req.destroy();
								resolve();
							});
						},
					);
					req.on("error", reject);
					req.end(JSON.stringify(input));
				});
				await Bun.sleep(500);
				await expect(fetch(`${h.url}/ping`)).rejects.toThrow();
				await h.checkRemoved();
				return;
			}
			const response = await fetch(`${h.url}/invocations`, {
				method: "POST",
				body: JSON.stringify(input),
			});
			expect(response.headers.get("content-type")).toBe("application/x-ndjson");
			{
				const messages = (await response.text())
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line));
				if (mode === "throw")
					expect(messages).toEqual([
						{
							type: "mymemo.error",
							code: "internal_error",
							detail: "injected failure",
						},
					]);
				else {
					expect(messages).toEqual(h.captured);
					expect(messages.at(-1)?.type).toBe("result");
					if (mode === "budget") expect(messages.at(-1)?.is_error).toBe(true);
					else {
						for (const type of [
							"system",
							"stream_event",
							"assistant",
							"user",
							"result",
						])
							expect(messages.some((m) => m.type === type)).toBe(true);
						expect(JSON.stringify(messages)).toContain("thinking_delta");
						expect(messages.at(-1)?.is_error).toBe(false);
					}
				}
			}
			await h.checkRemoved();
		} finally {
			await h.cleanup();
		}
	});
}

test("invoke boundary rejects unsafe payloads", () => {
	const input = payload();
	expect(invocationSchema.safeParse(input).success).toBe(true);
	for (const patch of [
		{ turnId: "../escape" },
		{ text: " " },
		{ text: "a".repeat(32769) },
		{ scope: { kind: "collection" } },
		{ budgetUntil: Number.MAX_SAFE_INTEGER },
		{ extra: true },
	]) {
		expect(invocationSchema.safeParse({ ...input, ...patch }).success).toBe(
			false,
		);
	}
});
