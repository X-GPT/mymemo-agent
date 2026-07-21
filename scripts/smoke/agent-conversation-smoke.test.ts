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
	id: string;
	data: Record<string, unknown>;
}

function sse(frames: Frame[]): Response {
	return new Response(
		frames
			.map(
				(frame) => `id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`,
			)
			.join(""),
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
			id: "1",
			data: { type: "RUN_STARTED", threadId: conversationId, runId },
		},
		{
			id: "2",
			data: {
				type: "TEXT_MESSAGE_START",
				messageId,
				role: "assistant",
			},
		},
		{
			id: "3",
			data: { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text },
		},
		{
			id: "4",
			data: { type: "TEXT_MESSAGE_END", messageId },
		},
		{
			id: "5",
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

	it("uses only strict Run admission and retained AG-UI reconnect", async () => {
		const conversationId = "conversation-1";
		const workspaceMarker = "workspace-0123456789abcdef0123456789abcdef";
		const workspaceHash = createHash("sha256")
			.update(workspaceMarker)
			.digest("hex");
		const runInputs: RunInput[] = [];
		const runFrames = new Map<string, Frame[]>();
		const paths: string[] = [];
		let sessionMarker = "";
		let artifactContent = "";

		const server = Bun.serve({
			port: 0,
			async fetch(request) {
				const url = new URL(request.url);
				paths.push(`${request.method} ${url.pathname}`);
				if (request.method === "POST" && url.pathname === "/v1/conversations") {
					return Response.json({ conversationId }, { status: 201 });
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
					runFrames.set(input.runId, frames);
					return sse(frames);
				}
				const replayMatch = url.pathname.match(
					/^\/v1\/conversations\/conversation-1\/runs\/([^/]+)\/events$/,
				);
				if (request.method === "GET" && replayMatch) {
					const frames = runFrames.get(replayMatch[1] ?? "") ?? [];
					const cursor = Number(request.headers.get("Last-Event-ID"));
					return sse(frames.filter((frame) => Number(frame.id) > cursor));
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
	});
});
