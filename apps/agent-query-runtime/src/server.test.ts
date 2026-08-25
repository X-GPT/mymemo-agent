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
import type { AgentQuerySessionStore } from "./session-store";

const conversationId = "0198b5a2-0d2b-7b64-9f65-4c9d49045111";

function responseDeadline() {
	return new Date(Date.now() + 60_000);
}

function streamEvent(event: Record<string, unknown>): SDKMessage {
	return {
		type: "stream_event",
		event,
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
	} as unknown as SDKMessage;
}

function assistantMessage(content: unknown[]): SDKMessage {
	return {
		type: "assistant",
		message: {
			id: crypto.randomUUID(),
			type: "message",
			role: "assistant",
			content,
			model: "claude-sonnet-5",
			stop_reason: "end_turn",
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 1 },
		},
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
	} as unknown as SDKMessage;
}

function toolResultMessage(
	toolUseId: string,
	content: unknown,
	overrides: Record<string, unknown> = {},
): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
		},
		parent_tool_use_id: null,
		uuid: crypto.randomUUID(),
		session_id: "agent-session-1",
		...overrides,
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
		assistantMessage([{ type: "text", text: "A direct answer." }]),
		resultEvent(),
	];
}

function queryMessages(
	messages: Iterable<SDKMessage> | AsyncIterable<SDKMessage>,
) {
	const stream = (async function* () {
		yield* messages;
	})();
	return Object.assign(stream, { async interrupt() {} });
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
	const sessionStore: AgentQuerySessionStore = {
		async append() {},
		async load() {
			return null;
		},
		async listSessions() {
			return [];
		},
		async listSubkeys() {
			return [];
		},
		async delete() {},
		mirroredMainSessionId() {
			return "agent-session-1";
		},
	};
	return {
		query() {
			return queryMessages(messages);
		},
		createSessionStore: () => sessionStore,
		async prepareWorkspace() {
			return {
				signal: new AbortController().signal,
				queryOptions: { allowedTools: [], mcpServers: {} },
				async stop() {},
				dispose() {},
			};
		},
		async prepareWorkingDirectory() {},
		async verifyResponseAuthority() {
			return responseDeadline();
		},
	};
}

describe("Agent-query Runtime HTTP boundary", () => {
	it("forwards one validated query and the controlled SDK stream as ordered NDJSON", async () => {
		const queries: Array<{ prompt: string; options: Options }> = [];
		const authorities: Array<{
			conversationId: string;
			conversationEpoch: number;
		}> = [];
		const workingDirectories: string[] = [];
		const messages = successfulMessages();
		const handle = createAgentQueryRequestHandler({
			...dependencies(messages),
			query(input) {
				queries.push(input);
				return queryMessages(messages);
			},
			async prepareWorkingDirectory(path) {
				workingDirectories.push(path);
			},
			async verifyResponseAuthority(authority) {
				authorities.push(authority);
				return responseDeadline();
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
		expect(queries).toHaveLength(1);
		expect(queries[0]).toMatchObject({
			prompt: "Tell me something",
			options: {
				allowedTools: [],
				mcpServers: {},
				model: "anthropic/claude-sonnet-5",
				includePartialMessages: true,
				cwd: `/workspace/conversations/${conversationId}`,
				permissionMode: "dontAsk",
				settingSources: [],
				thinking: { type: "disabled" },
				tools: [],
				resume: "opaque-agent-session",
			},
		});
		expect(queries[0]?.options.sessionStore).toBeDefined();
		expect(authorities).toEqual([{ conversationId, conversationEpoch: 7 }]);
		expect(workingDirectories).toEqual([
			`/workspace/conversations/${conversationId}`,
		]);
	});

	it("starts a fresh Agent session when the opaque session id is absent", async () => {
		const options: Options[] = [];
		const response = await createAgentQueryRequestHandler({
			...dependencies(),
			query(input) {
				options.push(input.options);
				return queryMessages(successfulMessages());
			},
			async prepareWorkingDirectory() {},
			async verifyResponseAuthority() {
				return responseDeadline();
			},
		})(request());

		expect(response.status).toBe(200);
		await response.text();
		expect(options).toHaveLength(1);
		expect(options[0]).not.toHaveProperty("resume");
	});

	it("binds the Postgres SessionStore and gates the terminal result on mirror evidence", async () => {
		let mirroredSessionId: string | null = null;
		const sessionStore = {
			async append(key: { sessionId: string }) {
				mirroredSessionId = key.sessionId;
			},
			async load() {
				return null;
			},
			async listSessions() {
				return [];
			},
			async listSubkeys() {
				return [];
			},
			async delete() {},
			mirroredMainSessionId() {
				return mirroredSessionId;
			},
		} as AgentQuerySessionStore;
		const deps = dependencies();
		const response = await createAgentQueryRequestHandler({
			...deps,
			createSessionStore: () => sessionStore,
			query(input) {
				return queryMessages(
					(async function* () {
						await input.options.sessionStore?.append(
							{
								projectKey: "-workspace-conversations-conversation",
								sessionId: "agent-session-1",
							},
							[{ type: "user", uuid: "entry-1" } as never],
						);
						yield* successfulMessages();
					})(),
				);
			},
		})(request());

		const lines = (await response.text())
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines.at(-1)).toMatchObject({
			type: "result",
			session_id: "agent-session-1",
		});
		expect(sessionStore.mirroredMainSessionId()).toBe("agent-session-1");
	});

	it("does not forward a terminal result without persisted transcript evidence", async () => {
		const deps = dependencies();
		const response = await createAgentQueryRequestHandler({
			...deps,
			createSessionStore: () => ({
				async append() {},
				async load() {
					return null;
				},
				async listSessions() {
					return [];
				},
				async listSubkeys() {
					return [];
				},
				async delete() {},
				mirroredMainSessionId() {
					return null;
				},
			}),
		})(request());

		await expect(response.text()).rejects.toThrow(
			"terminal Claude result has no persisted transcript",
		);
	});

	it("stops Claude and Workspace work when SessionStore persistence fails", async () => {
		let stopped = 0;
		let disposed = 0;
		let interrupted = 0;
		const deps = dependencies();
		const response = await createAgentQueryRequestHandler({
			...deps,
			createSessionStore: () => ({
				async append() {
					throw new Error("session persistence failed");
				},
				async load() {
					return null;
				},
				async listSessions() {
					return [];
				},
				async listSubkeys() {
					return [];
				},
				async delete() {},
				mirroredMainSessionId() {
					return null;
				},
			}),
			async prepareWorkspace() {
				return {
					signal: new AbortController().signal,
					queryOptions: { allowedTools: [], mcpServers: {} },
					async stop() {
						stopped++;
					},
					dispose() {
						disposed++;
					},
				};
			},
			query(input) {
				const messages = (async function* () {
					try {
						await input.options.sessionStore?.append(
							{ projectKey: "project", sessionId: "agent-session-1" },
							[{ type: "user", uuid: "entry-1" } as never],
						);
					} catch {
						yield {
							type: "system",
							subtype: "mirror_error",
							error: "private persistence failure",
							key: { projectKey: "project", sessionId: "agent-session-1" },
							uuid: crypto.randomUUID(),
							session_id: "agent-session-1",
						} as SDKMessage;
					}
					yield* successfulMessages();
				})();
				return Object.assign(messages, {
					async interrupt() {
						interrupted++;
					},
				});
			},
		})(request());

		await expect(response.text()).rejects.toThrow(
			"Claude session mirror failed",
		);
		expect({ stopped, disposed, interrupted }).toEqual({
			stopped: 1,
			disposed: 1,
			interrupted: 1,
		});
	});

	it("interrupts Claude and rejects completion when Workspace renewal fails", async () => {
		const workspaceController = new AbortController();
		let release!: () => void;
		const interrupted = new Promise<void>((resolve) => {
			release = resolve;
		});
		let interrupts = 0;
		const stream = (async function* () {
			await interrupted;
			yield* successfulMessages();
		})();
		let interruptFinished = false;
		const messages = Object.assign(stream, {
			async interrupt() {
				interrupts++;
				release();
				await Bun.sleep(5);
				interruptFinished = true;
			},
		});
		const response = await createAgentQueryRequestHandler({
			...dependencies(),
			query: () => messages,
			async prepareWorkspace() {
				return {
					signal: workspaceController.signal,
					queryOptions: { allowedTools: [], mcpServers: {} },
					async stop() {},
					dispose() {},
				};
			},
		})(request());

		workspaceController.abort(new Error("Workspace renewal failed"));

		await expect(response.text()).rejects.toThrow("Workspace renewal failed");
		expect(interrupts).toBe(1);
		expect(interruptFinished).toBe(true);
	});

	it("strictly rejects invalid envelopes and Runtime session identities before authority or query work", async () => {
		let verifications = 0;
		let queries = 0;
		const handle = createAgentQueryRequestHandler({
			...dependencies(),
			query() {
				queries++;
				return queryMessages(successfulMessages());
			},
			async prepareWorkingDirectory() {},
			async verifyResponseAuthority() {
				verifications++;
				return responseDeadline();
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
			...dependencies(),
			query() {
				queries++;
				return queryMessages(successfulMessages());
			},
			async prepareWorkingDirectory() {},
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

	it("rejects working-directory preparation failure before starting Claude", async () => {
		let queries = 0;
		const response = await createAgentQueryRequestHandler({
			...dependencies(),
			query() {
				queries++;
				return queryMessages(successfulMessages());
			},
			async prepareWorkingDirectory() {
				throw new Error("workspace unavailable");
			},
			async verifyResponseAuthority() {
				return responseDeadline();
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

	it("forwards completed Assistant and Tool messages in SDK order", async () => {
		const toolAssistant = assistantMessage([
			{ type: "text", text: "I will write the file." },
			{
				type: "tool_use",
				id: "tool-use-1",
				name: "mcp__mymemo-executor__Write",
				input: { path: "notes.md", content: "hello" },
			},
		]);
		const toolResult = toolResultMessage("tool-use-1", [
			{ type: "text", text: '{"bytesWritten":5}' },
		]);
		const replay = toolResultMessage("old-tool-use", "old", {
			isReplay: true,
		});
		const visible = successfulMessages();
		const response = await createAgentQueryRequestHandler(
			dependencies([toolAssistant, toolResult, replay, ...visible]),
		)(request());

		const text = await response.text();
		const lines = text
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines).toEqual([toolAssistant, toolResult, ...visible.slice(1)]);
		expect(text).not.toContain("old-tool-use");
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
			...dependencies(),
			query() {
				throw new Error("Claude unavailable");
			},
			async prepareWorkingDirectory() {},
			async verifyResponseAuthority() {
				return responseDeadline();
			},
		})(request());

		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			error: "AgentCore invocation failed",
		});
	});

	it("truncates the transport when Claude fails after streaming starts", async () => {
		const response = await createAgentQueryRequestHandler({
			...dependencies(),
			query() {
				return queryMessages(
					(async function* () {
						for (const message of successfulMessages().slice(1, 4)) {
							yield message;
						}
						throw new Error("transport failed");
					})(),
				);
			},
			async prepareWorkingDirectory() {},
			async verifyResponseAuthority() {
				return responseDeadline();
			},
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
		expect(received).toContain('"type":"stream_event"');
	});

	it("stops no later than the last confirmed deadline during database failure", async () => {
		const stopped = Promise.withResolvers<void>();
		let verifications = 0;
		let interruptions = 0;
		const handle = createAgentQueryRequestHandler({
			...dependencies(),
			authorityCheckIntervalMs: 1,
			async verifyResponseAuthority() {
				verifications++;
				if (verifications === 1) return new Date(Date.now() + 25);
				throw new Error("Postgres unavailable");
			},
			query() {
				const stream = (async function* () {
					await stopped.promise;
					yield* successfulMessages();
				})();
				return Object.assign(stream, {
					async interrupt() {
						interruptions++;
						stopped.resolve();
					},
				});
			},
		});

		const response = await handle(request());
		await expect(response.text()).rejects.toThrow("Response authority lost");
		expect(verifications).toBeGreaterThan(1);
		expect(interruptions).toBe(1);
	});

	it("suppresses a same-epoch duplicate without starting another Claude query", async () => {
		const release = Promise.withResolvers<void>();
		let queries = 0;
		const handle = createAgentQueryRequestHandler({
			...dependencies(),
			query() {
				queries++;
				const stream = (async function* () {
					await release.promise;
					yield* successfulMessages();
				})();
				return Object.assign(stream, { async interrupt() {} });
			},
		});

		const first = await handle(request());
		const firstText = first.text();
		const duplicate = await handle(request());
		expect(duplicate.status).toBe(409);
		expect(queries).toBe(1);
		release.resolve();
		await firstText;
		const completedDuplicate = await handle(request());
		expect(completedDuplicate.status).toBe(409);
		expect(queries).toBe(1);
	});

	it("settles an older local invocation before starting a newer epoch", async () => {
		const releaseFirst = Promise.withResolvers<void>();
		let queries = 0;
		let interruptions = 0;
		const handle = createAgentQueryRequestHandler({
			...dependencies(),
			query() {
				queries++;
				if (queries > 1) return queryMessages(successfulMessages());
				const stream = (async function* () {
					await releaseFirst.promise;
					yield* successfulMessages();
				})();
				return Object.assign(stream, {
					async interrupt() {
						interruptions++;
						releaseFirst.resolve();
					},
				});
			},
		});

		const first = await handle(request());
		const firstText = first.text();
		const replacement = await handle(request({ conversationEpoch: 8 }));
		expect(replacement.status).toBe(200);
		expect(await replacement.text()).toContain('"type":"result"');
		await expect(firstText).rejects.toThrow("Response authority lost");
		expect(interruptions).toBe(1);
		expect(queries).toBe(2);
	});

	it("returns 503 when prior-work cleanup cannot be proved in time", async () => {
		const release = Promise.withResolvers<void>();
		let queries = 0;
		const handle = createAgentQueryRequestHandler({
			...dependencies(),
			replacementCleanupMs: 5,
			query() {
				queries++;
				const stream = (async function* () {
					await release.promise;
					yield* successfulMessages();
				})();
				return Object.assign(stream, {
					async interrupt() {
						await release.promise;
					},
				});
			},
		});

		const first = await handle(request());
		const firstText = first.text().catch(() => "stopped");
		const replacement = await handle(request({ conversationEpoch: 8 }));
		expect(replacement.status).toBe(503);
		expect(await replacement.json()).toEqual({
			error: "Prior Agent query did not stop",
		});
		expect(queries).toBe(1);
		release.resolve();
		await firstText;
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

	it("disables Bun's idle timeout for a long Agent-query response", () => {
		const options = createAgentQueryServerOptions(dependencies(), 4510);

		expect(options.hostname).toBe("0.0.0.0");
		expect(options.port).toBe(4510);
		expect(options.idleTimeout).toBe(0);
		expect(options.routes).toHaveProperty("/ping");
		expect(options.routes).toHaveProperty("/invocations");
	});
});
