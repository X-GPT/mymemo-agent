/**
 * Split-runtime AG-UI integration — real Postgres, Redis, and processes.
 *
 * Postgres and Redis: chat-api atomically admits a run and its submitted
 * message, a deterministic worker claims it and appends one complete Assistant
 * message, and both POST and reconnect consume the same retained Redis Stream.
 * Unlike the PGlite unit tests — which exercise each side in isolation — this
 * crosses the writer→stream→client seam over the real coordination services.
 * The production worker always runs the real SDK; Task 9.7 owns its
 * credentialed end-to-end smoke proof.
 *
 * It needs no image build: the two apps and a disposable local Redis run as
 * subprocesses, while Postgres is provided externally (a GitHub Actions
 * `services: postgres` container in CI, or a local `postgres` you point
 * `AGENT_DATABASE_URL` at).
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
import { createServer } from "node:net";
import { resolve } from "node:path";
import { createDatabase } from "../packages/agent-db/src/client";

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
	data: Record<string, unknown>;
}

/** Parse standard AG-UI SSE: Redis cursor in `id`, BaseEvent JSON in `data`. */
function parseSSE(raw: string): SSEFrame[] {
	const frames: SSEFrame[] = [];
	for (const block of raw.split("\n\n")) {
		let id: string | undefined;
		let data = "";
		for (const line of block.split("\n")) {
			if (line.startsWith("id:")) id = line.slice("id:".length).trim();
			else if (line.startsWith("data:"))
				data = line.slice("data:".length).trim();
		}
		if (data) frames.push({ id, data: JSON.parse(data) });
	}
	return frames;
}

async function consumeSSE(
	response: Response,
	onFrame: (frame: SSEFrame) => Promise<void>,
): Promise<SSEFrame[]> {
	if (!response.body) throw new Error("SSE response omitted its body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const frames: SSEFrame[] = [];
	let buffered = "";
	for (;;) {
		const { done, value } = await reader.read();
		buffered += decoder.decode(value, { stream: !done });
		let boundary = buffered.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffered.slice(0, boundary + 2);
			buffered = buffered.slice(boundary + 2);
			for (const frame of parseSSE(block)) {
				frames.push(frame);
				await onFrame(frame);
			}
			boundary = buffered.indexOf("\n\n");
		}
		if (done) break;
	}
	for (const frame of parseSSE(buffered)) {
		frames.push(frame);
		await onFrame(frame);
	}
	return frames;
}

async function readUntilSSEFrameAndCancel(
	response: Response,
	eventType: string,
): Promise<{ frame: SSEFrame; raw: string }> {
	if (!response.body) throw new Error("SSE response omitted its body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = "";
	let raw = "";
	for (;;) {
		const { done, value } = await reader.read();
		const decoded = decoder.decode(value, { stream: !done });
		buffered += decoded;
		raw += decoded;
		let boundary = buffered.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffered.slice(0, boundary + 2);
			buffered = buffered.slice(boundary + 2);
			const [frame] = parseSSE(block);
			if (frame?.data.type === eventType) {
				await reader.cancel();
				return { frame, raw };
			}
			boundary = buffered.indexOf("\n\n");
		}
		if (done) throw new Error(`SSE response ended before ${eventType}`);
	}
}

function requiredFrame(frames: SSEFrame[], type: string): SSEFrame {
	const frame = frames.find((candidate) => candidate.data.type === type);
	if (!frame) throw new Error(`SSE response omitted ${type}`);
	return frame;
}

function fetchRunEvents(
	conversationId: string,
	runId: string,
	options: {
		memberCode?: string;
		cursor?: string;
		signal?: AbortSignal;
	} = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"x-member-code": options.memberCode ?? MEMBER_CODE,
		"x-partner-code": PARTNER_CODE,
	};
	if (options.cursor !== undefined) {
		headers["last-event-id"] = options.cursor;
	}
	return fetch(
		`${CHAT_URL}/v1/conversations/${conversationId}/runs/${runId}/events`,
		{ headers, signal: options.signal },
	);
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

async function waitForPersistedRun(
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const run = await acceptanceDb?.query.runs.findFirst({
			columns: { runId: true },
			where: (row, { eq }) => eq(row.runId, runId),
		});
		if (run) return;
		await Bun.sleep(50);
	}
	throw new Error(`Run ${runId} was not admitted before the deadline`);
}

async function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to allocate Redis test port"));
				return;
			}
			server.close((error) =>
				error ? reject(error) : resolvePort(address.port),
			);
		});
	});
}

async function startRedis(port: number): Promise<Bun.Subprocess> {
	const redis = Bun.spawn(
		[
			"redis-server",
			"--bind",
			"127.0.0.1",
			"--port",
			String(port),
			"--save",
			"",
			"--appendonly",
			"no",
		],
		{ stdout: "inherit", stderr: "inherit" },
	);
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		const ping = Bun.spawn(
			["redis-cli", "-h", "127.0.0.1", "-p", String(port), "ping"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		if ((await ping.exited) === 0) return redis;
		await Bun.sleep(50);
	}
	redis.kill();
	throw new Error("Redis did not become ready");
}

let chat: Bun.Subprocess | undefined;
let worker: Bun.Subprocess | undefined;
let redis: Bun.Subprocess | undefined;
let eventWriterEnv: Record<string, string> | undefined;
const acceptanceDb = DB_URL ? createDatabase(DB_URL) : undefined;

describe.skipIf(!RUN)(
	"split-runtime integration (real Postgres and Redis)",
	() => {
		beforeAll(async () => {
			const dbUrl = DB_URL as string;
			const redisPort = await freePort();
			redis = await startRedis(redisPort);
			const redisUrl = `redis://127.0.0.1:${redisPort}`;
			eventWriterEnv = {
				AGENT_DATABASE_URL: dbUrl,
				REDIS_URL: redisUrl,
				LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS: "true",
				DB_SSL: "disable",
				LOG_LEVEL: "warn",
				INTEGRATION_RESUME_DELAY_MS: "1500",
			};
			chat = spawnApp("chat-api", {
				AGENT_DATABASE_URL: dbUrl,
				ARTIFACT_BUCKET: "mymemo-agent-integration-artifacts",
				AWS_REGION: "us-west-2",
				DB_SSL: "disable",
				AGENT_EXPOSURE_BREAK_GLASS: "true",
				REDIS_URL: redisUrl,
				LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS: "true",
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

		afterAll(async () => {
			chat?.kill();
			worker?.kill();
			redis?.kill("SIGTERM");
			if (redis) await redis.exited;
			await acceptanceDb?.$client.end();
		});

		it(
			"waits, disconnects, and replays an authorized AG-UI Run from real Redis",
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

				const runId = crypto.randomUUID();
				const runInput = {
					threadId: conversationId,
					runId,
					state: {},
					messages: [
						{
							id: "integration-user-message",
							role: "user",
							content: "Hello from the split-runtime integration test.",
						},
					],
					tools: [],
					context: [],
					forwardedProps: {},
				};
				const runResponsePromise = fetch(
					`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-member-code": MEMBER_CODE,
							"x-partner-code": PARTNER_CODE,
						},
						body: JSON.stringify(runInput),
						signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
					},
				);
				await waitForPersistedRun(runId, 10_000);

				const missingRun = await fetchRunEvents(
					conversationId,
					crypto.randomUUID(),
				);
				expect(missingRun.status).toBe(404);
				const foreignRun = await fetchRunEvents(conversationId, runId, {
					memberCode: "foreign-member",
				});
				expect(foreignRun.status).toBe(404);
				const malformedCursor = await fetchRunEvents(conversationId, runId, {
					cursor: "not-a-cursor",
				});
				expect(malformedCursor.status).toBe(400);
				const impossibleBeforeCreation = await fetchRunEvents(
					conversationId,
					runId,
					{ cursor: "1-0" },
				);
				expect(impossibleBeforeCreation.status).toBe(400);

				const reconnectPromise = fetchRunEvents(conversationId, runId, {
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				});
				await Bun.sleep(5_200);
				if (!eventWriterEnv) throw new Error("event writer was not configured");
				worker = spawnEventWriter(eventWriterEnv);

				const reconnect = await reconnectPromise;
				expect(reconnect.status).toBe(200);
				const textDisconnect = await readUntilSSEFrameAndCancel(
					reconnect,
					"TEXT_MESSAGE_CONTENT",
				);
				expect(textDisconnect.raw).toContain(": ping\n\n");
				expect(textDisconnect.frame.data.type).toBe("TEXT_MESSAGE_CONTENT");
				expect(textDisconnect.frame.id).toMatch(/^\d+-\d+$/);

				const afterTextResponse = await fetchRunEvents(conversationId, runId, {
					cursor: textDisconnect.frame.id as string,
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				});
				expect(afterTextResponse.status).toBe(200);
				const toolDisconnect = await readUntilSSEFrameAndCancel(
					afterTextResponse,
					"TOOL_CALL_ARGS",
				);
				expect(toolDisconnect.frame.id).toMatch(/^\d+-\d+$/);

				const afterToolResponsePromise = fetchRunEvents(conversationId, runId, {
					cursor: toolDisconnect.frame.id as string,
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				});

				const res = await runResponsePromise;
				expect(res.status, "unexpected Run response status").toBe(200);

				const [frames, afterToolResponse] = await Promise.all([
					consumeSSE(res, async (frame) => {
						if (frame.data.type === "TEXT_MESSAGE_END") {
							const completed = await acceptanceDb?.query.runEvents.findFirst({
								columns: { type: true },
								where: (event, { and, eq }) =>
									and(
										eq(event.runId, runId),
										eq(event.type, "assistant_message_completed"),
									),
							});
							expect(completed?.type).toBe("assistant_message_completed");
						}
						if (frame.data.type === "RUN_FINISHED") {
							const terminal = await acceptanceDb?.query.runs.findFirst({
								columns: { status: true },
								where: (run, { eq }) => eq(run.runId, runId),
							});
							expect(terminal?.status).toBe("done");
						}
					}),
					afterToolResponsePromise,
				]);
				expect(afterToolResponse.status).toBe(200);
				const afterToolFrames = parseSSE(await afterToolResponse.text());
				const textDisconnectIndex = frames.findIndex(
					(frame) => frame.id === textDisconnect.frame.id,
				);
				const toolDisconnectIndex = frames.findIndex(
					(frame) => frame.id === toolDisconnect.frame.id,
				);
				expect(textDisconnectIndex).toBe(2);
				expect(toolDisconnectIndex).toBe(5);
				expect(parseSSE(toolDisconnect.raw)).toEqual(
					frames.slice(textDisconnectIndex + 1, toolDisconnectIndex + 1),
				);
				expect(afterToolFrames).toEqual(frames.slice(toolDisconnectIndex + 1));
				const eventTypes = frames.map((frame) => frame.data.type);
				expect(eventTypes).toEqual([
					"RUN_STARTED",
					"TEXT_MESSAGE_START",
					"TEXT_MESSAGE_CONTENT",
					"TEXT_MESSAGE_END",
					"TOOL_CALL_START",
					"TOOL_CALL_ARGS",
					"TOOL_CALL_END",
					"TOOL_CALL_RESULT",
					"RUN_FINISHED",
				]);
				expect(requiredFrame(frames, "RUN_STARTED").data).toMatchObject({
					threadId: conversationId,
					runId,
				});
				const streamedText = frames
					.filter((frame) => frame.data.type === "TEXT_MESSAGE_CONTENT")
					.map((frame) => frame.data.delta as string)
					.join("");
				expect(streamedText).toContain("Synthetic response");
				expect(streamedText).toContain(runId);
				expect(frames.every((frame) => /^\d+-\d+$/.test(frame.id ?? ""))).toBe(
					true,
				);

				const durableEvents = await acceptanceDb?.query.runEvents.findMany({
					columns: { type: true },
					where: (event, { eq }) => eq(event.runId, runId),
					orderBy: (event, { asc }) => asc(event.seq),
				});
				expect(durableEvents?.map((event) => event.type)).toEqual([
					"run_started",
					"assistant_message_completed",
					"tool_use",
					"tool_result",
					"run_done",
				]);
				const durableRun = await acceptanceDb?.query.runs.findFirst({
					columns: { status: true },
					where: (run, { eq }) => eq(run.runId, runId),
				});
				expect(durableRun?.status).toBe("done");

				const replayFromZero = await fetchRunEvents(conversationId, runId, {
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				});
				expect(replayFromZero.status).toBe(200);
				expect(parseSSE(await replayFromZero.text())).toEqual(frames);

				const impossibleRetainedCursor = await fetchRunEvents(
					conversationId,
					runId,
					{ cursor: "9999999999999-0" },
				);
				expect(impossibleRetainedCursor.status).toBe(400);

				const retry = await fetch(
					`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-member-code": MEMBER_CODE,
							"x-partner-code": PARTNER_CODE,
						},
						body: JSON.stringify(runInput),
						signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
					},
				);
				expect(retry.status).toBe(200);
				expect(parseSSE(await retry.text())).toEqual(frames);

				const mismatch = await fetch(
					`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
					{
						method: "POST",
						headers: {
							"content-type": "application/json",
							"x-member-code": MEMBER_CODE,
							"x-partner-code": PARTNER_CODE,
						},
						body: JSON.stringify({
							...runInput,
							messages: [
								{
									id: "integration-user-message",
									role: "user",
									content: "different work",
								},
							],
						}),
					},
				);
				expect(mismatch.status).toBe(409);
			},
			TURN_TIMEOUT_MS + 15_000,
		);
	},
);
