import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const script = resolve(import.meta.dir, "agent-conversation-smoke.ts");
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

interface RunInput {
	threadId: string;
	runId: string;
	messages: Array<{ id: string; role: string; content: string }>;
	tools: unknown[];
	context: unknown[];
}

interface Frame {
	data: Record<string, unknown>;
}

function sse(frames: Frame[]): Response {
	return new Response(
		frames.map((frame) => `data: ${JSON.stringify(frame.data)}\n\n`).join(""),
		{ headers: { "content-type": "text/event-stream" } },
	);
}

function successfulRun(
	conversationId: string,
	runId: string,
	text: string,
): Frame[] {
	const messageId = `assistant-${runId}`;
	return [
		{
			data: { type: "RUN_STARTED", threadId: conversationId, runId },
		},
		{
			data: {
				type: "TEXT_MESSAGE_START",
				messageId,
				role: "assistant",
			},
		},
		{
			data: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
		},
		{
			data: { type: "TEXT_MESSAGE_END", messageId },
		},
		{
			data: { type: "RUN_FINISHED", threadId: conversationId, runId },
		},
	];
}

async function runSmoke(
	baseUrl: string,
	extraEnv: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn([process.execPath, "run", script], {
		cwd: root,
		env: {
			...Bun.env,
			AGENT_SMOKE_BASE_URL: baseUrl,
			AGENT_SMOKE_TURN_TIMEOUT_MS: "5000",
			...extraEnv,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

describe("agent conversation smoke", () => {
	it("passes when the exposure gate is closed", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: () =>
				new Response('{"error":"Agent is not enabled"}', { status: 403 }),
		});
		servers.push(server);

		const result = await runSmoke(`http://127.0.0.1:${server.port}`);

		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain("Statsig gate is closed by default");
	});

	it("refuses to admit a Run when the created Conversation is not agentcore", async () => {
		const paths: string[] = [];
		const server = Bun.serve({
			port: 0,
			fetch(request) {
				const url = new URL(request.url);
				paths.push(`${request.method} ${url.pathname}`);
				if (request.method === "POST" && url.pathname === "/v1/conversations") {
					return Response.json(
						{
							conversationId: "fargate-conversation",
							executionRuntime: "fargate",
						},
						{ status: 201 },
					);
				}
				return new Response("unexpected request", { status: 500 });
			},
		});
		servers.push(server);

		const result = await runSmoke(`http://127.0.0.1:${server.port}`, {
			AGENT_SMOKE_EXPECT_GATE_CLOSED: "false",
			AGENT_SMOKE_EXPECT_EXECUTION_RUNTIME: "agentcore",
		});

		expect(result.exitCode).not.toBe(0);
		expect(result.stderr).toContain(
			"conversation create selected fargate, expected agentcore",
		);
		expect(paths).toEqual(["POST /v1/conversations"]);
	});

	it("uses strict Run admission and terminal history recovery", async () => {
		const conversationId = "conversation-1";
		const workspaceMarker = "workspace-0123456789abcdef0123456789abcdef";
		const workspaceHash = createHash("sha256")
			.update(workspaceMarker)
			.digest("hex");
		const runInputs: RunInput[] = [];
		const historyRuns: Array<Record<string, unknown>> = [];
		const paths: string[] = [];
		const reconnectEventIds: Array<string | null> = [];
		let sessionMarker = "";
		let artifactContent = "";

		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				paths.push(`${request.method} ${url.pathname}`);
				if (request.method === "POST" && url.pathname === "/v1/conversations") {
					return Response.json(
						{ conversationId, executionRuntime: "agentcore" },
						{ status: 201 },
					);
				}
				if (
					request.method === "POST" &&
					url.pathname === `/v1/conversations/${conversationId}/runs`
				) {
					const input = (await request.json()) as RunInput;
					runInputs.push(input);
					const prompt = input.messages[0]?.content ?? "";
					let reply: string;
					if (prompt.includes("TURN1_SHA256")) {
						sessionMarker = prompt.match(/agent-session-[0-9a-f-]+/)?.[0] ?? "";
						reply = `TURN1_SHA256=${workspaceHash}`;
					} else if (prompt.includes("SESSION_MARKER=")) {
						reply = `SESSION_MARKER=${sessionMarker}\nWORKSPACE_MARKER=${workspaceMarker}`;
					} else {
						artifactContent = prompt.match(/ARTIFACT_CONTENT=(.+)/)?.[1] ?? "";
						reply = "ARTIFACT_WRITTEN";
					}
					const frames = successfulRun(conversationId, input.runId, reply);
					historyRuns.push({
						runId: input.runId,
						messages: [
							input.messages[0],
							{
								id: `assistant-${input.runId}`,
								role: "assistant",
								content: reply,
							},
						],
						terminalEvent: {
							type: "RUN_FINISHED",
							threadId: conversationId,
							runId: input.runId,
						},
					});
					return sse(frames);
				}
				const replayMatch = url.pathname.match(
					/^\/v1\/conversations\/conversation-1\/runs\/([^/]+)\/events$/,
				);
				if (request.method === "GET" && replayMatch) {
					reconnectEventIds.push(request.headers.get("Last-Event-ID"));
					return Response.json(
						{
							error: "Live stream unavailable",
							recovery: "history",
						},
						{ status: 410 },
					);
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/conversations/${conversationId}/history`
				) {
					return Response.json({
						conversation: { conversationId },
						runs: historyRuns,
						nextCursor: null,
						activeRun: null,
					});
				}
				if (
					request.method === "GET" &&
					url.pathname === `/v1/conversations/${conversationId}/artifacts`
				) {
					return Response.json({
						artifacts: [
							{
								artifactId: "artifact-1",
								path: "smoke/core-check.txt",
								sizeBytes: new TextEncoder().encode(artifactContent).byteLength,
							},
						],
					});
				}
				if (url.pathname.endsWith("/artifacts/artifact-1/download-url")) {
					return Response.json({
						downloadUrl: `http://127.0.0.1:${server.port}/download`,
					});
				}
				if (url.pathname === "/download") {
					return new Response(artifactContent, {
						headers: {
							"content-disposition": 'attachment; filename="core-check.txt"',
						},
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const result = await runSmoke(`http://127.0.0.1:${server.port}`, {
			AGENT_SMOKE_EXPECT_GATE_CLOSED: "false",
			AGENT_SMOKE_EXPECT_EXECUTION_RUNTIME: "agentcore",
		});

		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(result.stdout).toContain("agent live smoke passed: suite=core");
		expect(runInputs).toHaveLength(3);
		for (const input of runInputs) {
			expect(input).toMatchObject({
				threadId: conversationId,
				tools: [],
				context: [],
			});
			expect(input.runId).toBeTruthy();
			expect(input.messages).toHaveLength(1);
			expect(input.messages[0]).toMatchObject({ role: "user" });
		}
		expect(paths).not.toContain(
			`POST /v1/conversations/${conversationId}/events`,
		);
		expect(paths.filter((path) => path.endsWith("/events"))).toHaveLength(3);
		expect(reconnectEventIds).toEqual([null, null, null]);
	});
});
