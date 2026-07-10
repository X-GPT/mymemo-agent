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
}): Response {
	const frames: Array<{
		id: string;
		event: string;
		data: Record<string, unknown>;
	}> = [
		{
			id: "1",
			event: "conversation_id",
			data: { type: "conversation_id", conversationId: input.conversationId },
		},
		{
			id: "1",
			event: "run_id",
			data: { type: "run_id", runId: input.runId },
		},
		{
			id: "2",
			event: "text_delta",
			data: { type: "text_delta", text: input.text },
		},
	];
	if (input.includeDone !== false) {
		frames.push({ id: "3", event: "done", data: { type: "done" } });
	}
	return new Response(
		`${frames
			.map(
				(frame) =>
					`id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}`,
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
					return sseTurn({
						conversationId,
						runId: `run-${turn}`,
						text:
							turn === 1
								? `TURN1_SHA256=${workspaceHash}`
								: `SESSION_MARKER=${extractSessionMarker(messages[0]?.text)}\nWORKSPACE_MARKER=${workspaceMarker}`,
					});
				}

				return new Response("not found", { status: 404 });
			},
		});
		servers.push(server);

		const { exitCode, stdout, stderr } = await runSmoke(
			`http://127.0.0.1:${server.port}`,
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
		]);
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
