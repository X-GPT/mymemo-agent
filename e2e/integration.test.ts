/**
 * Split-runtime projection integration — real Postgres, real processes.
 *
 * Runs the actual client path across two real processes talking to a real
 * Postgres: chat-api queues a run, a test-only worker process claims it and
 * appends one complete Assistant message, and chat-api projects the durable
 * events back over SSE. Unlike the PGlite unit tests — which exercise each side in isolation —
 * this crosses the writer→projector seam over one database, so a vocabulary
 * desync fails here instead of reaching a client. The production worker always
 * runs the real SDK; Task 9.7 owns its credentialed end-to-end smoke proof.
 *
 * It needs no image build: the two apps run as `bun` subprocesses and Postgres
 * is provided externally (a GitHub Actions `services: postgres` container in CI,
 * or a local `postgres` you point `AGENT_DATABASE_URL` at). This is why it can
 * run on every PR where the Docker-compose harness cannot.
 *
 * Gated on `AGENT_DATABASE_URL`: with none set it skips (so it never runs in the
 * PGlite unit suite). CI runs it via the `integration` job in `.github/workflows/
 * ci.yml`, which starts the Postgres service, applies the `@mymemo/agent-db`
 * migrations, then invokes:
 *
 *   AGENT_DATABASE_URL=postgres://… DB_SSL=disable bun test e2e/integration.test.ts
 *
 * Locally: start a Postgres, apply migrations (`bun run --cwd apps/chat-api
 * db:migrate`), then run the line above.
 *
 * Overridable knobs:
 *   CHAT_API_PORT        chat-api listen port  (default 3100)
 *   INTEGRATION_TIMEOUT_MS  per-turn ceiling   (default 30000)
 */

import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { resolve } from "node:path";

const DB_URL = process.env.AGENT_DATABASE_URL;
const RUN = Boolean(DB_URL);

const REPO_ROOT = resolve(import.meta.dir, "..");
const CHAT_PORT = Number(process.env.CHAT_API_PORT ?? 3100);
const CHAT_URL = `http://localhost:${CHAT_PORT}`;
const rawTurnTimeout = Number(process.env.INTEGRATION_TIMEOUT_MS);
const TURN_TIMEOUT_MS =
	Number.isFinite(rawTurnTimeout) && rawTurnTimeout > 0
		? rawTurnTimeout
		: 30_000;

// Bringing two bun processes up + one turn stays well under a minute; raise the
// hook default off 5s only when the suite will actually run.
if (RUN) setDefaultTimeout(90_000);

const MEMBER_CODE = "demo-member";
const PARTNER_CODE = "demo-partner";

interface SSEFrame {
	id?: string;
	event: string;
	data: string;
}

/** Parse an SSE body into {id, event, data} frames (mirrors chat.route.test.ts). */
function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.split("\n\n")) {
		let id: string | undefined;
		let event = "";
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) id = line.slice("id:".length).trim();
			else if (line.startsWith("event:"))
				event = line.slice("event:".length).trim();
			else if (line.startsWith("data:"))
				data = line.slice("data:".length).trim();
		}
		if (event) frames.push({ id, event, data });
	}
	return frames;
}

function requiredFrame(frames: SSEFrame[], event: string): SSEFrame {
	const frame = frames.find((candidate) => candidate.event === event);
	if (!frame) throw new Error(`SSE response omitted ${event}`);
	return frame;
}

/** Spawn `bun run src/index.ts` for an app under apps/<name>. Output is inherited
 * so a boot failure surfaces directly in the test/CI logs. */
function spawnApp(name: string, env: Record<string, string>) {
	return Bun.spawn(["bun", "run", "src/index.ts"], {
		cwd: resolve(REPO_ROOT, "apps", name),
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
}

/** Spawn the deterministic test-only queue/event writer. */
function spawnEventWriter(env: Record<string, string>) {
	return Bun.spawn(["bun", "run", "e2e/synthetic-worker.ts"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
}

async function chatApiHealthy(): Promise<boolean> {
	try {
		const res = await fetch(`${CHAT_URL}/health`, {
			signal: AbortSignal.timeout(2_000),
		});
		return res.ok;
	} catch {
		return false;
	}
}

async function waitForHealthy(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await chatApiHealthy()) return true;
		await Bun.sleep(500);
	}
	return false;
}

let chat: Bun.Subprocess | undefined;
let worker: Bun.Subprocess | undefined;

describe.skipIf(!RUN)("split-runtime integration (real Postgres)", () => {
	beforeAll(async () => {
		const dbUrl = DB_URL as string;
		worker = spawnEventWriter({
			AGENT_DATABASE_URL: dbUrl,
			DB_SSL: "disable",
			LOG_LEVEL: "warn",
		});
		chat = spawnApp("chat-api", {
			AGENT_DATABASE_URL: dbUrl,
			DB_SSL: "disable",
			AGENT_EXPOSURE_BREAK_GLASS: "true",
			PORT: String(CHAT_PORT),
			LOG_LEVEL: "warn",
		});

		if (!(await waitForHealthy(30_000))) {
			throw new Error(
				`chat-api did not become healthy at ${CHAT_URL}. Ensure AGENT_DATABASE_URL ` +
					`points at a migrated Postgres (see this file's header).`,
			);
		}
	});

	afterAll(() => {
		chat?.kill();
		worker?.kill();
	});

	it(
		"creates a conversation, queues a run, and projects durable worker events to done",
		async () => {
			// Create the conversation (general scope). Proves migrations provisioned
			// the `conversations` table and chat-api's writable DB is reachable.
			const createRes = await fetch(`${CHAT_URL}/v1/conversations`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-member-code": MEMBER_CODE,
					"x-partner-code": PARTNER_CODE,
				},
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(15_000),
			});
			const createBody = await createRes.text();
			expect(
				createRes.status,
				`create conversation failed; body: ${createBody.slice(0, 500)}`,
			).toBe(201);
			const conversationId = JSON.parse(createBody).conversationId as string;
			expect(conversationId.length).toBeGreaterThan(0);

			// Append a user.message and stream the turn. The test worker claims the
			// queued run, appends assistant text, and terminalizes `done`;
			// chat-api projects those durable events over SSE.
			const res = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/events`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-member-code": MEMBER_CODE,
						"x-partner-code": PARTNER_CODE,
					},
					body: JSON.stringify({
						type: "user.message",
						text: "Hello from the split-runtime integration test.",
					}),
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				},
			);
			const bodyText = await res.text();
			expect(
				res.status,
				`unexpected status; body: ${bodyText.slice(0, 500)}`,
			).toBe(200);

			const frames = parseSSE(bodyText);
			const events = frames.map((f) => f.event).filter((e) => e !== "ping");

			// The split-runtime vocabulary streamed, no error; `sandbox_id` is not
			// part of the contract (a prototype-era internal identifier).
			expect(events).toContain("conversation_id");
			expect(events).toContain("run_id");
			expect(events).toContain("text_commit");
			expect(events).toContain("done");
			expect(events).not.toContain("error");
			expect(events).not.toContain("sandbox_id");

			const echoedConversationId = JSON.parse(
				requiredFrame(frames, "conversation_id").data,
			).conversationId as string;
			expect(echoedConversationId).toBe(conversationId);
			const runId = JSON.parse(requiredFrame(frames, "run_id").data)
				.runId as string;
			expect(runId.length).toBeGreaterThan(0);

			// The committed text is the test worker's response for this run — proof it
			// crossed the worker→projector seam, not produced by chat-api.
			const streamedText = frames
				.filter((f) => f.event === "text_commit")
				.map((f) => JSON.parse(f.data).text as string)
				.join("");
			expect(streamedText).toContain("Synthetic response");
			expect(streamedText).toContain(runId);

			// The tool events crossed the same seam (ADR-0009): the worker's recorded
			// payloads arrive as same-named durable frames, in append order, each
			// carrying its run-event sequence as the SSE id.
			const nonPing = frames.filter((f) => f.event !== "ping");
			const toolUseIndex = nonPing.findIndex((f) => f.event === "tool_use");
			const toolResultIndex = nonPing.findIndex(
				(f) => f.event === "tool_result",
			);
			const commitIndex = nonPing.findIndex((f) => f.event === "text_commit");
			expect(toolUseIndex).toBeGreaterThan(-1);
			expect(toolResultIndex).toBe(toolUseIndex + 1);
			expect(commitIndex).toBe(toolResultIndex + 1);

			const toolUseFrame = requiredFrame(frames, "tool_use");
			expect(JSON.parse(toolUseFrame.data)).toEqual({
				type: "tool_use",
				tool: "Bash",
				arguments: { command: `echo ${runId}`, timeoutMs: 10_000 },
				truncated: false,
			});
			const toolResultFrame = requiredFrame(frames, "tool_result");
			expect(JSON.parse(toolResultFrame.data)).toEqual({
				type: "tool_result",
				tool: "Bash",
				result: {
					exitCode: 0,
					stdout: `${runId}\n`,
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					outcome: "completed",
				},
				isError: false,
				truncated: false,
			});
			// Both frames are durable: consecutive run-event sequences as SSE ids.
			expect(Number(toolUseFrame.id)).toBeGreaterThan(0);
			expect(Number(toolResultFrame.id)).toBe(Number(toolUseFrame.id) + 1);
		},
		TURN_TIMEOUT_MS + 15_000,
	);
});
