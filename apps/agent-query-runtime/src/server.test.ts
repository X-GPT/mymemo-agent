import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { workspaceImportGraph } from "@mymemo/test-support/import-graph";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	type AgentQueryRuntimeDependencies,
	createAgentQueryRequestHandler,
	createAgentQueryServerOptions,
} from "./server";

const conversationId = "0198b5a2-0d2b-7b64-9f65-4c9d49045111";

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
	} as unknown as SDKMessage;
}

function resultEvent(overrides: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		duration_ms: 100,
		duration_api_ms: 80,
		is_error: false,
		num_turns: 1,
		result: "provider-only terminal echo",
		stop_reason: "end_turn",
		total_cost_usd: 0.01,
		usage: {},
		modelUsage: {},
		permission_denials: [],
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
		...overrides,
	} as unknown as SDKMessage;
}

function errorResultEvent(overrides: Record<string, unknown> = {}): SDKMessage {
	return {
		type: "result",
		subtype: "error_during_execution",
		duration_ms: 100,
		duration_api_ms: 80,
		is_error: true,
		num_turns: 1,
		stop_reason: null,
		total_cost_usd: 0.01,
		usage: {},
		modelUsage: {},
		permission_denials: [],
		errors: ["private provider failure"],
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
		...overrides,
	} as unknown as SDKMessage;
}

function successfulMessages(): SDKMessage[] {
	return [
		{ type: "system", subtype: "init" } as unknown as SDKMessage,
		streamEvent({
			type: "message_start",
			message: { id: "provider-message-1", content: [] },
		}),
		streamEvent({
			type: "content_block_start",
			index: 0,
			content_block: { type: "text", text: "" },
		}),
		streamEvent({
			type: "content_block_delta",
			index: 0,
			delta: { type: "text_delta", text: "A direct answer." },
		}),
		streamEvent({ type: "content_block_stop", index: 0 }),
		streamEvent({ type: "message_stop" }),
		resultEvent(),
	];
}

function request(
	body: Record<string, unknown> = {},
	runtimeSessionId = conversationId,
) {
	return new Request("http://runtime/invocations", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[AGENTCORE_RUNTIME_SESSION_HEADER]: runtimeSessionId,
		},
		body: JSON.stringify({
			version: 1,
			conversationId,
			conversationEpoch: 7,
			prompt: "Tell me something",
			model: "anthropic/claude-sonnet-5",
			...body,
		}),
	});
}

function dependencies(
	messages: SDKMessage[] = successfulMessages(),
): AgentQueryRuntimeDependencies {
	return {
		async *query() {
			yield* messages;
		},
		async verifyResponseAuthority() {},
	};
}

describe("direct-response AgentCore Runtime HTTP boundary", () => {
	it("forwards one validated query and streams the controlled native subset as ordered NDJSON", async () => {
		const queries: Array<{ prompt: string; options: Options }> = [];
		const authorities: Array<{
			conversationId: string;
			conversationEpoch: number;
		}> = [];
		const messages = successfulMessages();
		const handle = createAgentQueryRequestHandler({
			async *query(input) {
				queries.push(input);
				yield* messages;
			},
			async verifyResponseAuthority(authority) {
				authorities.push(authority);
			},
		});

		const response = await handle(
			request({ agentSessionId: "opaque-agent-session" }),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-ndjson");
		const lines = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual(messages.slice(1));
		expect(lines.at(-1)).toEqual(messages.at(-1));
		expect(queries).toEqual([
			{
				prompt: "Tell me something",
				options: {
					allowedTools: [],
					model: "anthropic/claude-sonnet-5",
					includePartialMessages: true,
					cwd: `/workspace/conversations/${conversationId}`,
					permissionMode: "dontAsk",
					settingSources: [],
					tools: [],
					resume: "opaque-agent-session",
				},
			},
		]);
		expect(authorities).toEqual([{ conversationId, conversationEpoch: 7 }]);
	});

	it("starts a fresh Agent session when the opaque session id is absent", async () => {
		const options: Options[] = [];
		const response = await createAgentQueryRequestHandler({
			async *query(input) {
				options.push(input.options);
				yield* successfulMessages();
			},
			async verifyResponseAuthority() {},
		})(request());

		expect(response.status).toBe(200);
		await response.text();
		expect(options).toHaveLength(1);
		expect(options[0]).not.toHaveProperty("resume");
	});

	it("strictly rejects invalid envelopes and Runtime session identities before authority or query work", async () => {
		let verifications = 0;
		let queries = 0;
		const handle = createAgentQueryRequestHandler({
			async *query() {
				queries++;
				yield* successfulMessages();
			},
			async verifyResponseAuthority() {
				verifications++;
			},
		});
		const invalidRequests = [
			request({ version: 2 }),
			request({ extra: true }),
			request({ conversationId: "invalid/id" }, "invalid/id"),
			request({ conversationEpoch: -1 }),
			request({ conversationEpoch: 1.5 }),
			request({ prompt: "" }),
			request({ model: " " }),
			request({ agentSessionId: "" }),
			request({}, "different-session"),
			new Request("http://runtime/invocations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{",
			}),
		];

		for (const invalid of invalidRequests) {
			const response = await handle(invalid);
			expect(response.status).toBe(400);
		}
		expect(verifications).toBe(0);
		expect(queries).toBe(0);
	});

	it("rejects an authority-verifier failure before starting Claude", async () => {
		let queries = 0;
		const response = await createAgentQueryRequestHandler({
			async *query() {
				queries++;
				yield* successfulMessages();
			},
			async verifyResponseAuthority() {
				throw new Error("stale response authority");
			},
		})(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "AgentCore invocation failed",
		});
		expect(queries).toBe(0);
	});

	it("streams a terminal Claude failure without inventing an error event", async () => {
		const failure = errorResultEvent();
		const response = await createAgentQueryRequestHandler(
			dependencies([...successfulMessages().slice(0, -1), failure]),
		)(request());

		const lines = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.at(-1)).toEqual(failure);
		expect(lines.some((line) => line.type === "error")).toBe(false);
	});

	it("truncates the response rather than forwarding unsupported Claude content", async () => {
		const hidden = [
			streamEvent({
				type: "message_start",
				message: { id: "provider-tool-message", content: [] },
			}),
			streamEvent({
				type: "content_block_start",
				index: 0,
				content_block: {
					type: "tool_use",
					id: "private-tool-use",
					name: "PrivateTool",
					input: {},
				},
			}),
			streamEvent({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: "{}" },
			}),
			streamEvent({ type: "content_block_stop", index: 0 }),
			streamEvent({ type: "message_stop" }),
		];
		const response = await createAgentQueryRequestHandler(
			dependencies([...hidden, ...successfulMessages()]),
		)(request());

		await expect(response.text()).rejects.toThrow(
			"unsupported Claude content block",
		);
	});

	it("truncates invalid or contradictory terminal Claude results", async () => {
		const invalidResults = [
			resultEvent({ subtype: "unknown_result" }),
			resultEvent({ is_error: true }),
			resultEvent({ duration_ms: undefined }),
			resultEvent({ subtype: "error_during_execution", errors: [] }),
		];

		for (const result of invalidResults) {
			const response = await createAgentQueryRequestHandler(
				dependencies([...successfulMessages().slice(0, -1), result]),
			)(request());
			await expect(response.text()).rejects.toThrow(
				"invalid terminal Claude result",
			);
		}
	});

	it("rejects a Claude startup failure without a second error protocol", async () => {
		const response = await createAgentQueryRequestHandler({
			query() {
				throw new Error("Claude unavailable");
			},
			async verifyResponseAuthority() {},
		})(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "AgentCore invocation failed",
		});
	});

	it("truncates the transport when Claude fails after streaming starts", async () => {
		const response = await createAgentQueryRequestHandler({
			async *query() {
				for (const message of successfulMessages().slice(1, 4)) {
					yield message;
				}
				throw new Error("transport failed");
			},
			async verifyResponseAuthority() {},
		})(request());
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected response body");

		let received = "";
		const decoder = new TextDecoder();
		const drain = (async () => {
			for (;;) {
				const part = await reader.read();
				if (part.done) return;
				received += decoder.decode(part.value, { stream: true });
			}
		})();
		await expect(drain).rejects.toThrow("transport failed");
		expect(received).toContain("message_start");
	});

	it("provides a Bun.serve image without importing Run or background-execution controls", () => {
		const root = join(import.meta.dir, "../../..");
		const graph = workspaceImportGraph(root, join(import.meta.dir, "index.ts"));
		for (const path of graph) {
			for (const forbidden of [
				"/run-store",
				"/run-serving",
				"/agentcore-dispatch",
				"/queue",
				"/outbox",
				"/reclamation",
				"/conversation-ownership",
			]) {
				expect(path).not.toContain(forbidden);
			}
		}

		const entrypoint = readFileSync(join(import.meta.dir, "index.ts"), "utf8");
		const dockerfile = readFileSync(
			join(import.meta.dir, "../Dockerfile"),
			"utf8",
		);
		expect(entrypoint).toContain("Bun.serve(");
		expect(entrypoint).toContain(
			'import { query } from "@anthropic-ai/claude-agent-sdk"',
		);
		expect(dockerfile).toContain('ENTRYPOINT [ "bun", "run", "src/index.ts" ]');
	});

	it("disables Bun's idle timeout for a long direct response", () => {
		const options = createAgentQueryServerOptions(dependencies(), 4510);

		expect(options.hostname).toBe("0.0.0.0");
		expect(options.port).toBe(4510);
		expect(options.idleTimeout).toBe(0);
		expect(options.routes).toHaveProperty("/ping");
		expect(options.routes).toHaveProperty("/invocations");
	});
});
