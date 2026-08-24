import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { workspaceImportGraph } from "@mymemo/test-support/import-graph";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	type AgentQueryRuntimeDependencies,
	createAgentQueryRequestHandler,
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
		is_error: false,
		result: "provider-only terminal echo",
		session_id: "agent-session-1",
		...overrides,
	} as SDKMessage;
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
		expect(lines.at(-1)).toEqual(resultEvent());
		expect(queries).toEqual([
			{
				prompt: "Tell me something",
				options: {
					model: "anthropic/claude-sonnet-5",
					includePartialMessages: true,
					cwd: `/workspace/conversations/${conversationId}`,
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
		const failure = resultEvent({
			subtype: "error_during_execution",
			is_error: true,
			errors: ["private provider failure"],
		});
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
				yield successfulMessages()[1] as SDKMessage;
				throw new Error("transport failed");
			},
			async verifyResponseAuthority() {},
		})(request());
		const reader = response.body?.getReader();
		if (!reader) throw new Error("expected response body");

		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toContain("message_start");
		await expect(reader.read()).rejects.toThrow("transport failed");
	});

	it("imports no Run, Dispatch, queue, outbox, or background-execution control path", () => {
		const root = join(import.meta.dir, "../../..");
		const graph = workspaceImportGraph(
			root,
			join(import.meta.dir, "server.ts"),
		);
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
	});
});
