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
	it("proves agent-session resume and persisted workspace contents across two runs", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000233";
		const workspaceMarker = "workspace-0123456789abcdef0123456789abcdef";
		const workspaceHash = createHash("sha256")
			.update(workspaceMarker)
			.digest("hex");
		const messages: UserMessage[] = [];
		const identityHeaders: Array<[string | null, string | null]> = [];
		const responsesByRun = new Map<string, string>();
		const reconnectCursors: string[] = [];

		const server = Bun.serve({
			port: await availablePort(),
			async fetch(request) {
				const url = new URL(request.url);
				identityHeaders.push([
					request.headers.get("x-member-code"),
					request.headers.get("x-partner-code"),
				]);
				if (url.pathname === "/v1/conversations") {
					return Response.json(
						{ conversationId, scope: "general" },
						{ status: 201 },
					);
				}

				if (url.pathname === `/v1/conversations/${conversationId}/events`) {
					messages.push((await request.json()) as UserMessage);
					const turn = messages.length;
					const runId = `run-${turn}`;
					const text =
						turn === 1
							? `TURN1_SHA256=${workspaceHash}`
							: `SESSION_MARKER=${extractSessionMarker(messages[0]?.text)}\nWORKSPACE_MARKER=${workspaceMarker}`;
					responsesByRun.set(runId, text);
					return sseTurn({
						conversationId,
						runId,
						includePreview: true,
						text,
					});
				}
				const reconnect = url.pathname.match(
					new RegExp(
						`^/v1/conversations/${conversationId}/runs/(run-[0-9]+)/events$`,
					),
				);
				if (request.method === "GET" && reconnect) {
					reconnectCursors.push(request.headers.get("last-event-id") ?? "");
					const runId = reconnect[1] as string;
					const text = responsesByRun.get(runId);
					if (!text) return new Response("not found", { status: 404 });
					return sseTurn({
						conversationId,
						runId,
						text,
						includeLifecycle: false,
					});
				}

				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const { exitCode, stdout, stderr } = await runSmoke(
			`http://127.0.0.1:${server.port}`,
			{ AGENT_SMOKE_PREVIEW_MODE: "required" },
		);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("agent live smoke passed");
		expect(stdout).toContain(conversationId);
		expect(stdout).toContain("run-1");
		expect(stdout).toContain("run-2");
		expect(messages).toHaveLength(2);
		expect(messages[0]?.type).toBe("user.message");
		expect(messages[0]?.text).toContain("Bash");
		expect(messages[0]?.text).toContain("/home/user/.mymemo-live-smoke");
		expect(messages[0]?.text).toContain("sha256");
		expect(messages[1]?.type).toBe("user.message");
		expect(messages[1]?.text).toContain("previous turn");
		expect(messages[1]?.text).toContain("Read");
		expect(messages[1]?.text).not.toContain(
			extractSessionMarker(messages[0]?.text),
		);
		expect(identityHeaders).toEqual([
			["live-smoke-member", "live-smoke-partner"],
			["live-smoke-member", "live-smoke-partner"],
			["live-smoke-member", "live-smoke-partner"],
			["live-smoke-member", "live-smoke-partner"],
			["live-smoke-member", "live-smoke-partner"],
		]);
		expect(reconnectCursors).toEqual(["1", "1"]);
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

	it("proves exact durable delivery and replay with Redis preview disabled", async () => {
		const conversationId = "00000000-0000-4000-8000-000000000235";
		const workspaceMarker = "workspace-fedcba9876543210fedcba9876543210";
		const workspaceHash = createHash("sha256")
			.update(workspaceMarker)
			.digest("hex");
		const messages: UserMessage[] = [];
		const responsesByRun = new Map<string, string>();
		const reconnectCursors: string[] = [];

		const server = Bun.serve({
			port: await availablePort(),
			async fetch(request) {
				const url = new URL(request.url);
				if (url.pathname === "/v1/conversations") {
					return Response.json(
						{ conversationId, scope: "general" },
						{ status: 201 },
					);
				}
				if (url.pathname === `/v1/conversations/${conversationId}/events`) {
					messages.push((await request.json()) as UserMessage);
					const turn = messages.length;
					const runId = `disabled-run-${turn}`;
					const text =
						turn === 1
							? `TURN1_SHA256=${workspaceHash}`
							: `SESSION_MARKER=${extractSessionMarker(messages[0]?.text)}\nWORKSPACE_MARKER=${workspaceMarker}`;
					responsesByRun.set(runId, text);
					return sseTurn({ conversationId, runId, text });
				}
				const reconnect = url.pathname.match(
					new RegExp(
						`^/v1/conversations/${conversationId}/runs/(disabled-run-[0-9]+)/events$`,
					),
				);
				if (request.method === "GET" && reconnect) {
					reconnectCursors.push(request.headers.get("last-event-id") ?? "");
					const runId = reconnect[1] as string;
					const text = responsesByRun.get(runId);
					if (!text) return new Response("not found", { status: 404 });
					return sseTurn({
						conversationId,
						runId,
						text,
						includeLifecycle: false,
					});
				}
				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const { exitCode, stdout, stderr } = await runSmoke(
			`http://127.0.0.1:${server.port}`,
			{ AGENT_SMOKE_PREVIEW_MODE: "forbidden" },
		);

		expect(stderr).toBe("");
		expect(exitCode).toBe(0);
		expect(stdout).toContain("preview=forbidden");
		expect(reconnectCursors).toEqual(["1", "1"]);
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
