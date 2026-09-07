import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { query, type SDKMessage } from "claude-agent-sdk";
import {
	createRuntimeServer,
	invocationSchema,
	logger,
	RUNTIME_CWD,
} from "./runtime";

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
const calls = [
	["Bash", { command: "touch /tmp/mymemo-should-not-execute" }],
	["Write", { file_path: "/ws/notes.txt", content: "hello" }],
	["Read", { file_path: "/ws/notes.txt" }],
	[
		"Edit",
		{ file_path: "/ws/notes.txt", old_string: "hello", new_string: "hi" },
	],
	["Glob", { pattern: "*.txt" }],
	["Grep", { pattern: "hi" }],
] as const;
function fakeMessages(index: number) {
	const tool = calls[index];
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
		? [{ type: "tool_use", id: `tool_${index}`, name: tool[0], input: {} }]
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
					partial_json: JSON.stringify(tool[1]),
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

async function harness(
	mode:
		| "normal"
		| "budget"
		| "disconnect"
		| "throw"
		| "mid-throw"
		| "dead-sandbox"
		| "memory"
		| "upload-failure"
		| "download-failure",
	objects = new Map<string, Buffer>(),
) {
	const cwd = await realpath(await mkdtemp(join(tmpdir(), "runtime-test-")));
	const captured: SDKMessage[] = [];
	let configDir = "";
	let modelCalls = 0;
	const messageCounts: number[] = [];
	const operations: string[] = [];
	const s3 = new S3Client({ region: "us-west-2" });
	s3.send = async (command) => {
		const input = command.input as {
			Key: string;
			Bucket: string;
			Body?: Buffer;
		};
		expect(input.Bucket).toBe("transcript-test");
		expect(input.Key).toMatch(/^_transcripts\/[0-9a-f-]+\.jsonl$/);
		if (command instanceof GetObjectCommand) {
			operations.push("get");
			if (mode === "download-failure")
				throw Object.assign(new Error("access denied"), {
					name: "AccessDenied",
				});
			const body = objects.get(input.Key);
			if (!body)
				throw Object.assign(new Error("absent"), {
					name: mode === "memory" ? "AccessDenied" : "NoSuchKey",
				});
			return { Body: { transformToByteArray: async () => body } };
		}
		expect(command).toBeInstanceOf(PutObjectCommand);
		operations.push("put");
		if (mode === "upload-failure") throw new Error("upload unavailable");
		assert(input.Body);
		objects.set(input.Key, Buffer.from(input.Body));
		return {};
	};
	const fake = Bun.serve({
		port: 0,
		idleTimeout: 0,
		async fetch(request) {
			if (!new URL(request.url).pathname.endsWith("/messages"))
				return new Response("{}", { status: 404 });
			const body = (await request.json()) as {
				tools?: { name: string }[];
				messages: unknown[];
			};
			expect((body.tools ?? []).map((tool) => tool.name).sort()).toEqual(
				["bash", "read", "write", "edit", "glob", "grep"]
					.map((n) => `mcp__hand__${n}`)
					.sort(),
			);
			modelCalls++;
			messageCounts.push(body.messages.length);
			if (mode === "budget" || mode === "disconnect")
				return new Response(new ReadableStream({}), {
					headers: { "content-type": "text/event-stream" },
				});
			return new Response(
				fakeMessages(mode === "memory" ? calls.length : modelCalls - 1),
				{
					headers: { "content-type": "text/event-stream" },
				},
			);
		},
	});
	const server = createRuntimeServer(
		{
			cwd,
			handInvoke: () => async (name) => {
				if (mode === "dead-sandbox")
					throw Object.assign(new Error("session is not active"), {
						name: "ValidationException",
					});
				if (name === "readFiles")
					return {
						content: [
							{ type: "resource", resource: { type: "text", text: "hello" } },
						],
					};
				return {
					content: [],
					structuredContent: {
						stdout: JSON.stringify({
							value: "",
							truncated: false,
							totalBytes: 0,
							exitCode: 0,
						}),
						exitCode: 0,
					},
				};
			},
			s3,
			bucket: "transcript-test",
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
			expect(configDir).toMatch(/^\/tmp\/claude\/[0-9a-f-]+$/);
			const sessionId = params.options?.resume ?? params.options?.sessionId;
			expect(sessionId).toBeDefined();
			if (params.options?.resume) {
				expect(params.options.sessionId).toBeUndefined();
				expect(
					existsSync(
						join(
							configDir,
							"projects",
							cwd.replace(/[^a-zA-Z0-9]/g, "-"),
							`${sessionId}.jsonl`,
						),
					),
				).toBe(true);
			}
			expect(params.options?.tools).toEqual([]);
			expect(params.options?.permissionMode).toBe("dontAsk");
			expect(params.options?.settingSources).toEqual([]);
			if (mode === "throw") throw new Error("injected failure");
			const active = query(params);
			if (mode === "disconnect") return active;
			const iterator = active[Symbol.asyncIterator].bind(active);
			active[Symbol.asyncIterator] = async function* () {
				for await (const message of { [Symbol.asyncIterator]: iterator }) {
					if (mode === "mid-throw" && captured.length)
						throw new Error("injected failure");
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
		objects,
		operations,
		messageCounts,
		get configDir() {
			return configDir;
		},
		async cleanup() {
			await server.stop(true);
			fake.stop(true);
			s3.destroy();
			await rm(cwd, { recursive: true, force: true });
		},
		async checkRemoved() {
			for (let i = 0; i < 100 && existsSync(configDir); i++)
				await Bun.sleep(100);
			expect(existsSync(configDir)).toBe(false);
		},
	};
}

for (const mode of [
	"normal",
	"budget",
	"disconnect",
	"throw",
	"mid-throw",
	"dead-sandbox",
	"upload-failure",
	"download-failure",
] as const) {
	test(`real SDK: ${mode}`, async () => {
		const log = spyOn(logger, "error").mockImplementation(() => {});
		const h = await harness(mode);
		try {
			const input = payload();
			if (mode === "download-failure") input.seq = 2;
			if (mode === "budget") input.budgetUntil = Date.now() + 128_000;
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
				if (mode === "dead-sandbox") {
					expect(messages.at(-1)?.type).toBe("mymemo.error");
					expect(messages.at(-1)?.code).toBe("internal_error");
					expect(messages.some((m) => m.type === "result")).toBe(false);
				} else if (mode === "mid-throw") {
					expect(messages.slice(0, -1)).toEqual(h.captured);
					expect(messages.at(-1)).toEqual({
						type: "mymemo.error",
						code: "internal_error",
						detail: "injected failure",
					});
				} else if (mode === "throw" || mode === "download-failure")
					expect(messages).toEqual([
						{
							type: "mymemo.error",
							code: "internal_error",
							detail:
								mode === "download-failure"
									? "access denied"
									: "injected failure",
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
						const results = messages
							.filter((m) => m.type === "user")
							.flatMap((m) => m.message.content)
							.filter((b: { type: string }) => b.type === "tool_result");
						expect(results).toHaveLength(6);
						expect(
							results.every((b: { is_error?: boolean }) => !b.is_error),
						).toBe(true);
					}
				}
			}
			await h.checkRemoved();
			expect(h.operations).toEqual([
				"get",
				...(["normal", "budget", "upload-failure"].includes(mode)
					? ["put"]
					: []),
			]);
			if (mode === "upload-failure") {
				expect(log).toHaveBeenCalledTimes(1);
				expect(log.mock.calls[0]?.[0]).toMatchObject({
					conversationId: input.conversationId,
					turnId: input.turnId,
					TranscriptUploadFailures: 1,
					_aws: {
						CloudWatchMetrics: [
							{
								Namespace: "MyMemo/AgentRuntime",
								Dimensions: [[]],
								Metrics: [{ Name: "TranscriptUploadFailures", Unit: "Count" }],
							},
						],
					},
				});
			}
		} finally {
			await h.cleanup();
			log.mockRestore();
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

test("three fresh config directories resume one growing CLI transcript", async () => {
	const objects = new Map<string, Buffer>();
	const input = payload();
	const sizes: number[] = [];
	const counts: number[] = [];
	const dirs = new Set<string>();
	expect(RUNTIME_CWD.replace(/[^a-zA-Z0-9]/g, "-")).toBe("-opt-mymemo-project");
	for (let seq = 1; seq <= 3; seq++) {
		const h = await harness("memory", objects);
		try {
			const response = await fetch(`${h.url}/invocations`, {
				method: "POST",
				body: JSON.stringify({ ...input, seq, turnId: crypto.randomUUID() }),
			});
			const messages = (await response.text())
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
			expect(messages.at(-1)).toMatchObject({
				type: "result",
				is_error: false,
				session_id: input.conversationId,
			});
			expect(h.operations).toEqual(["get", "put"]);
			counts.push(...h.messageCounts);
			dirs.add(h.configDir);
			const transcript = objects.get(
				`_transcripts/${input.conversationId}.jsonl`,
			);
			assert(transcript);
			expect(transcript.length).toBeGreaterThan(sizes.at(-1) ?? 0);
			sizes.push(transcript.length);
			await h.checkRemoved();
		} finally {
			await h.cleanup();
		}
	}
	expect(dirs.size).toBe(3);
	expect(objects.size).toBe(1);
	expect(counts).toEqual([2, 5, 8]);
	console.log(
		JSON.stringify({ messageCounts: counts, transcriptBytes: sizes }),
	);
});
