import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const servers: Bun.Server<unknown>[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) server.stop(true);
});

interface UserMessage {
	type: "user.message";
	text: string;
}

interface StubRequest {
	pathname: string;
	memberCode: string | null;
	partnerCode: string | null;
}

interface SmokeStubOptions {
	conversationId: string;
	workspaceMarker: string;
	runIdPrefix: string;
	includePreview?: boolean;
	artifactContent?: (requestedContent: string) => string;
}

interface SmokeStub {
	baseUrl: string;
	messages: UserMessage[];
	reconnectCursors: string[];
	requests: StubRequest[];
}

function sseTurn(input: {
	conversationId: string;
	runId: string;
	text: string;
	includeDone?: boolean;
	includePreview?: boolean;
	includeLifecycle?: boolean;
	commitTexts?: string[];
}): Response {
	const frames: Array<{
		id?: string;
		event: string;
		data: Record<string, unknown>;
	}> = [];
	if (input.includeLifecycle !== false) {
		frames.push({
			id: "1",
			event: "conversation_id",
			data: { type: "conversation_id", conversationId: input.conversationId },
		});
		frames.push({
			id: "1",
			event: "run_id",
			data: { type: "run_id", runId: input.runId },
		});
	}
	if (input.includePreview) {
		frames.push({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: `message-${input.runId}`,
				deltaIndex: 0,
				text: input.text.slice(0, Math.ceil(input.text.length / 2)),
			},
		});
	}
	const commitTexts = input.commitTexts ?? [input.text];
	for (const [index, text] of commitTexts.entries()) {
		frames.push({
			id: String(index + 2),
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId:
					commitTexts.length === 1
						? `message-${input.runId}`
						: `message-${input.runId}-${index}`,
				text,
			},
		});
	}
	if (input.includeDone !== false) {
		frames.push({
			id: String(commitTexts.length + 2),
			event: "done",
			data: { type: "done" },
		});
	}
	return new Response(
		`${frames
			.map(
				(frame) =>
					`${frame.id === undefined ? "" : `id: ${frame.id}\n`}event: ${frame.event}\ndata: ${JSON.stringify(frame.data)}`,
			)
			.join("\n\n")}\n\n`,
		{ headers: { "content-type": "text/event-stream" } },
	);
}

describe("agent conversation live smoke", () => {
	it("runs the core continuity and artifact checks with Live preview", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000233";
		const workspaceMarker = "workspace-0123456789abcdef0123456789abcdef";
		const stub = await startSmokeStub({
			conversationId,
			workspaceMarker,
			runIdPrefix: "run",
			includePreview: true,
		});

		const { exitCode, stdout, stderr } = await runSmoke(stub.baseUrl, {
			AGENT_SMOKE_PREVIEW_MODE: "required",
		});

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("agent live smoke passed");
		expect(stdout).toContain("suite=core");
		expect(stdout).toContain(conversationId);
		expect(stdout).toContain("run-1");
		expect(stdout).toContain("run-2");
		expect(stdout).toContain("run-3");
		expect(stub.messages).toHaveLength(3);
		expect(stub.messages[0]?.type).toBe("user.message");
		expect(stub.messages[0]?.text).toContain("Bash");
		expect(stub.messages[0]?.text).toContain("/home/user/.mymemo-live-smoke");
		expect(stub.messages[0]?.text).toContain("sha256");
		expect(stub.messages[1]?.type).toBe("user.message");
		expect(stub.messages[1]?.text).toContain("previous turn");
		expect(stub.messages[1]?.text).toContain("Read");
		expect(stub.messages[1]?.text).not.toContain(
			extractSessionMarker(stub.messages[0]?.text),
		);
		const artifact = extractArtifactRequest(stub.messages[2]?.text);
		expect(artifact.relativePath).toBe("smoke/core-check.txt");
		expect(artifact.content).toMatch(/^mymemo-core-artifact-[0-9a-f-]{36}$/);
		expect(stub.requests.slice(0, -1).map(identityFromRequest)).toEqual(
			Array.from({ length: 9 }, () => [
				"live-smoke-member",
				"live-smoke-partner",
			]),
		);
		expect(identityFromRequest(stub.requests.at(-1))).toEqual([null, null]);
		expect(stub.reconnectCursors).toEqual(["1", "1", "1"]);
	});

	it("rejects a non-positive turn timeout before making a request", async () => {
		const { exitCode, stderr } = await runSmoke("http://127.0.0.1:1", {
			AGENT_SMOKE_TURN_TIMEOUT_MS: "0",
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain(
			"AGENT_SMOKE_TURN_TIMEOUT_MS must be a positive integer",
		);
	});

	it("rejects an unknown suite before making a request", async () => {
		const { exitCode, stderr } = await runSmoke("http://127.0.0.1:1", {
			AGENT_SMOKE_SUITE: "extended",
		});

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("AGENT_SMOKE_SUITE must be core or full");
		expect(stderr).not.toContain("Unable to connect");
	});

	it("runs the full suite's core checks with Redis preview disabled", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000235";
		const workspaceMarker = "workspace-fedcba9876543210fedcba9876543210";
		const stub = await startSmokeStub({
			conversationId,
			workspaceMarker,
			runIdPrefix: "disabled-run",
			artifactContent: (content) => `${content}\n`,
		});

		const { exitCode, stdout, stderr } = await runSmoke(stub.baseUrl, {
			AGENT_SMOKE_PREVIEW_MODE: "forbidden",
			AGENT_SMOKE_SUITE: "full",
		});

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("suite=full");
		expect(stdout).toContain("preview=forbidden");
		expect(extractArtifactRequest(stub.messages[2]?.text).relativePath).toBe(
			"smoke/core-check.txt",
		);
		expect(identityFromRequest(stub.requests.at(-1))).toEqual([null, null]);
		expect(stub.reconnectCursors).toEqual(["1", "1", "1"]);
	});

	it("rejects a signed artifact whose bytes do not match the request", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000237";
		const workspaceMarker = "workspace-11111111111111111111111111111111";
		const stub = await startSmokeStub({
			conversationId,
			workspaceMarker,
			runIdPrefix: "tampered-run",
			artifactContent: (content) => "x".repeat(content.length),
		});

		const { exitCode, stderr } = await runSmoke(stub.baseUrl);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain(
			"downloaded artifact bytes did not match requested content",
		);
	});

	it("rejects an assistant stream that never records the done outcome", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000234";
		const server = Bun.serve({
			port: await availablePort(),
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/v1/conversations") {
					return Response.json(
						{ conversationId, scope: "general" },
						{ status: 201 },
					);
				}
				return sseTurn({
					conversationId,
					runId: "run-without-done",
					text: "TURN1_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
					includeDone: false,
				});
			},
		});
		servers.push(server);

		const { exitCode, stderr } = await runSmoke(
			`http://127.0.0.1:${server.port}`,
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain("event stream did not end in done");
	});

	it("rejects a provider-complete response split across multiple commits", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000236";
		const exact =
			"TURN1_SHA256=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const server = Bun.serve({
			port: await availablePort(),
			fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/v1/conversations") {
					return Response.json(
						{ conversationId, scope: "general" },
						{ status: 201 },
					);
				}
				return sseTurn({
					conversationId,
					runId: "split-run",
					text: exact,
					commitTexts: [exact.slice(0, 20), exact.slice(20)],
				});
			},
		});
		servers.push(server);

		const { exitCode, stderr } = await runSmoke(
			`http://127.0.0.1:${server.port}`,
		);

		expect(exitCode).not.toBe(0);
		expect(stderr).toContain(
			"expected exactly one provider-complete Assistant message",
		);
	});
});

async function startSmokeStub(input: SmokeStubOptions): Promise<SmokeStub> {
	const messages: UserMessage[] = [];
	const reconnectCursors: string[] = [];
	const requests: StubRequest[] = [];
	const responsesByRun = new Map<string, string>();
	const workspaceHash = createHash("sha256")
		.update(input.workspaceMarker)
		.digest("hex");
	const artifactId = `${input.runIdPrefix}-artifact`;
	const signedPath = `/signed/${artifactId}`;
	let downloadedContent = "";
	const port = await availablePort();

	const server = Bun.serve({
		port,
		async fetch(request) {
			const url = new URL(request.url);
			requests.push({
				pathname: url.pathname,
				memberCode: request.headers.get("x-member-code"),
				partnerCode: request.headers.get("x-partner-code"),
			});
			if (url.pathname === "/v1/conversations") {
				return Response.json(
					{ conversationId: input.conversationId, scope: "general" },
					{ status: 201 },
				);
			}
			if (
				request.method === "POST" &&
				url.pathname === `/v1/conversations/${input.conversationId}/events`
			) {
				messages.push((await request.json()) as UserMessage);
				const turn = messages.length;
				const runId = `${input.runIdPrefix}-${turn}`;
				const text =
					turn === 1
						? `TURN1_SHA256=${workspaceHash}`
						: turn === 2
							? `SESSION_MARKER=${extractSessionMarker(messages[0]?.text)}\nWORKSPACE_MARKER=${input.workspaceMarker}`
							: "ARTIFACT_WRITTEN";
				responsesByRun.set(runId, text);
				return sseTurn({
					conversationId: input.conversationId,
					runId,
					includePreview: input.includePreview,
					text,
				});
			}

			const reconnectPrefix = `/v1/conversations/${input.conversationId}/runs/`;
			const reconnectSuffix = "/events";
			if (
				request.method === "GET" &&
				url.pathname.startsWith(reconnectPrefix) &&
				url.pathname.endsWith(reconnectSuffix)
			) {
				reconnectCursors.push(request.headers.get("last-event-id") ?? "");
				const runId = url.pathname.slice(
					reconnectPrefix.length,
					-reconnectSuffix.length,
				);
				const text = responsesByRun.get(runId);
				if (!text) return new Response("not found", { status: 404 });
				return sseTurn({
					conversationId: input.conversationId,
					runId,
					text,
					includeLifecycle: false,
				});
			}

			if (
				request.method === "GET" &&
				url.pathname === `/v1/conversations/${input.conversationId}/artifacts`
			) {
				const artifact = extractArtifactRequest(messages[2]?.text);
				downloadedContent = input.artifactContent
					? input.artifactContent(artifact.content)
					: artifact.content;
				return Response.json({
					artifacts: [
						{
							artifactId,
							path: artifact.relativePath,
							sizeBytes: new TextEncoder().encode(downloadedContent).byteLength,
							contentType: "text/plain",
							createdAt: "2026-07-17T00:00:00.000Z",
							updatedAt: "2026-07-17T00:00:00.000Z",
						},
					],
				});
			}
			if (
				request.method === "GET" &&
				url.pathname ===
					`/v1/conversations/${input.conversationId}/artifacts/${artifactId}/download-url`
			) {
				return Response.json({
					downloadUrl: `http://127.0.0.1:${port}${signedPath}`,
				});
			}
			if (request.method === "GET" && url.pathname === signedPath) {
				return new Response(downloadedContent, {
					headers: {
						"content-disposition": 'attachment; filename="core-check.txt"',
						"content-type": "text/plain",
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});
	servers.push(server);
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		messages,
		reconnectCursors,
		requests,
	};
}

function identityFromRequest(
	request: StubRequest | undefined,
): [string | null, string | null] {
	if (!request) throw new Error("expected stub request");
	return [request.memberCode, request.partnerCode];
}

async function runSmoke(
	baseUrl: string,
	env: Record<string, string> = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const child = Bun.spawn(
		["bun", "run", "scripts/smoke/agent-conversation-smoke.ts"],
		{
			cwd: root,
			env: {
				...process.env,
				AGENT_SMOKE_BASE_URL: baseUrl,
				AGENT_SMOKE_EXPECT_GATE_CLOSED: "false",
				AGENT_SMOKE_MEMBER_CODE: "live-smoke-member",
				AGENT_SMOKE_PARTNER_CODE: "live-smoke-partner",
				AGENT_SMOKE_TURN_TIMEOUT_MS: "5000",
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	return { exitCode, stdout, stderr };
}

function extractSessionMarker(prompt: string | undefined): string {
	const marker = prompt?.match(/agent-session-[0-9a-f-]{36}/)?.[0];
	if (!marker)
		throw new Error("first-turn prompt did not contain a session marker");
	return marker;
}

function extractArtifactRequest(prompt: string | undefined): {
	relativePath: string;
	content: string;
} {
	const absolutePath = prompt?.match(
		/^ARTIFACT_PATH=(\/home\/user\/artifacts\/.+)$/m,
	)?.[1];
	const content = prompt?.match(/^ARTIFACT_CONTENT=(.+)$/m)?.[1];
	if (!absolutePath || !content) {
		throw new Error("artifact-turn prompt did not contain path and content");
	}
	return {
		relativePath: absolutePath.slice("/home/user/artifacts/".length),
		content,
	};
}

async function availablePort(): Promise<number> {
	return await new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				server.close();
				reject(new Error("could not reserve a smoke-test port"));
				return;
			}
			server.close((error) => {
				if (error) reject(error);
				else resolvePort(address.port);
			});
		});
	});
}
