/**
 * AgentCore AG-UI integration — real Postgres, Redis, HTTP, and processes.
 *
 * Postgres and Redis: chat-api atomically admits a run and its submitted
 * message, a deterministic AgentCore Runtime performs durable acquisition and
 * appends one complete Assistant message, and both POST and reconnect attach
 * to the same Redis Live Stream relay.
 * Unlike the PGlite unit tests — which exercise each side in isolation — this
 * crosses the Runtime→Live Stream→client seam over real coordination services.
 * Production always runs the real SDK; the credentialed smoke owns that proof.
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
 *   CHAT_API_PORT           fixed chat-api listen port (default: free port)
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
import {
	type AgUiSseFrame,
	parseAgUiSse,
} from "@mymemo/test-support/ag-ui-sse";
import {
	findFreePort,
	type RedisTestServer,
	startRedisTestServer,
} from "@mymemo/test-support/redis-test-server";
import { createDatabase } from "../packages/agent-db/src/client";
import {
	expireUnownedQueuedRunsTx,
	reclaimConversationTx,
} from "../packages/agent-db/src/run-store";

const DB_URL = process.env.AGENT_DATABASE_URL;
const RUN = Boolean(DB_URL);

const REPO_ROOT = resolve(import.meta.dir, "..");
const configuredChatPort = process.env.CHAT_API_PORT;
let chatPort =
	configuredChatPort === undefined ? 0 : Number(configuredChatPort);
let CHAT_URL = "";
const rawTurnTimeout = Number(process.env.INTEGRATION_TIMEOUT_MS);
const TURN_TIMEOUT_MS =
	Number.isFinite(rawTurnTimeout) && rawTurnTimeout > 0
		? rawTurnTimeout
		: 30_000;

// Bringing two bun processes up + one turn stays well under a minute; raise the
// hook default off 5s only when the suite will actually run.
if (RUN) setDefaultTimeout(90_000);

const MEMBER_CODE = `acceptance-${crypto.randomUUID()}`;
const PARTNER_CODE = "demo-partner";
const IDENTITY_HEADERS = {
	"x-member-code": MEMBER_CODE,
	"x-partner-code": PARTNER_CODE,
};
const JSON_IDENTITY_HEADERS = {
	...IDENTITY_HEADERS,
	"content-type": "application/json",
};

async function consumeSSE(
	response: Response,
	onFrame: (frame: AgUiSseFrame) => Promise<void>,
): Promise<AgUiSseFrame[]> {
	if (!response.body) throw new Error("SSE response omitted its body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const frames: AgUiSseFrame[] = [];
	let buffered = "";
	for (;;) {
		const { done, value } = await reader.read();
		buffered += decoder.decode(value, { stream: !done });
		let boundary = buffered.indexOf("\n\n");
		while (boundary >= 0) {
			const block = buffered.slice(0, boundary + 2);
			buffered = buffered.slice(boundary + 2);
			for (const frame of parseAgUiSse(block)) {
				frames.push(frame);
				await onFrame(frame);
			}
			boundary = buffered.indexOf("\n\n");
		}
		if (done) break;
	}
	for (const frame of parseAgUiSse(buffered)) {
		frames.push(frame);
		await onFrame(frame);
	}
	return frames;
}

async function readUntilSSEFrameAndCancel(
	response: Response,
	eventType: string,
): Promise<{ frame: AgUiSseFrame; raw: string }> {
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
			const [frame] = parseAgUiSse(block);
			if (frame?.data.type === eventType) {
				await reader.cancel();
				return { frame, raw };
			}
			boundary = buffered.indexOf("\n\n");
		}
		if (done) throw new Error(`SSE response ended before ${eventType}`);
	}
}

function requiredFrame(frames: AgUiSseFrame[], type: string): AgUiSseFrame {
	const frame = frames.find((candidate) => candidate.data.type === type);
	if (!frame) throw new Error(`SSE response omitted ${type}`);
	return frame;
}

function fetchRunEvents(
	conversationId: string,
	runId: string,
	options: {
		memberCode?: string;
		lastEventId?: string;
		signal?: AbortSignal;
	} = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		...IDENTITY_HEADERS,
		"x-member-code": options.memberCode ?? MEMBER_CODE,
	};
	if (options.lastEventId !== undefined) {
		headers["last-event-id"] = options.lastEventId;
	}
	return fetch(
		`${CHAT_URL}/v1/conversations/${conversationId}/runs/${runId}/events`,
		{ headers, signal: options.signal },
	);
}

function interruptRun(
	conversationId: string,
	runId: string,
	memberCode = MEMBER_CODE,
): Promise<Response> {
	return fetch(
		`${CHAT_URL}/v1/conversations/${conversationId}/runs/${runId}/interrupt`,
		{
			method: "POST",
			headers: {
				...IDENTITY_HEADERS,
				"x-member-code": memberCode,
			},
		},
	);
}

/** Spawn the deterministic test-only AgentCore Runtime. */
function spawnAgentCoreRuntime(env: Record<string, string>) {
	return Bun.spawn(["bun", "run", "e2e/synthetic-agentcore-runtime.ts"], {
		cwd: REPO_ROOT,
		env: { ...process.env, ...env },
		stdout: "inherit",
		stderr: "inherit",
	});
}

/** Release 1 keeps global expiration and Reclamation outside AgentCore
 * Runtime. Drive that production ordering from the outer test orchestration so
 * Runtime failure cannot also remove the maintenance backstop under test. */
function startAgentCoreMaintenance(databaseUrl: string): () => Promise<void> {
	const database = createDatabase(databaseUrl);
	let stopping = false;
	let failure: unknown;
	let activeSweep = Promise.resolve();

	async function sweep(): Promise<void> {
		while (await expireUnownedQueuedRunsTx(database)) {}
		while (await reclaimConversationTx(database)) {}
	}

	function scheduleSweep(): void {
		if (stopping || failure !== undefined) return;
		activeSweep = activeSweep.then(sweep).catch((error) => {
			failure = error;
		});
	}

	const interval = setInterval(scheduleSweep, 500);
	scheduleSweep();
	return async () => {
		stopping = true;
		clearInterval(interval);
		await activeSweep;
		await database.$client.end();
		if (failure !== undefined) throw failure;
	};
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

async function waitForRunVisible(
	conversationId: string,
	runId: string,
	timeoutMs: number,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(
			`${CHAT_URL}/v1/conversations/${conversationId}/history`,
			{
				headers: IDENTITY_HEADERS,
			},
		);
		if (response.ok) {
			const history = (await response.json()) as {
				runs: Array<{ runId: string }>;
			};
			if (history.runs.some((run) => run.runId === runId)) return;
		}
		await Bun.sleep(50);
	}
	throw new Error(`Run ${runId} was not admitted before the deadline`);
}

async function admitIntegrationRun(prompt: string): Promise<{
	conversationId: string;
	runId: string;
	response: Promise<Response>;
}> {
	const createResponse = await fetch(`${CHAT_URL}/v1/conversations`, {
		method: "POST",
		headers: JSON_IDENTITY_HEADERS,
		body: JSON.stringify({}),
		signal: AbortSignal.timeout(15_000),
	});
	expect(createResponse.status).toBe(201);
	const conversationId = (await createResponse.json()).conversationId as string;
	const runId = crypto.randomUUID();
	const response = fetch(
		`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
		{
			method: "POST",
			headers: JSON_IDENTITY_HEADERS,
			body: JSON.stringify({
				threadId: conversationId,
				runId,
				state: {},
				messages: [
					{
						id: `user-${runId}`,
						role: "user",
						content: prompt,
					},
				],
				tools: [],
				context: [],
				forwardedProps: {},
			}),
			signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
		},
	);
	await waitForRunVisible(conversationId, runId, 10_000);
	return { conversationId, runId, response };
}

interface AcceptanceHistoryRun {
	runId: string;
	messages: Array<Record<string, unknown>>;
	terminalEvent: { type: string; [key: string]: unknown } | null;
}

async function waitForHistoryRun(
	conversationId: string,
	runId: string,
	terminalType: string,
	timeoutMs: number,
): Promise<AcceptanceHistoryRun> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const response = await fetch(
			`${CHAT_URL}/v1/conversations/${conversationId}/history`,
			{
				headers: IDENTITY_HEADERS,
			},
		);
		if (response.ok) {
			const history = (await response.json()) as {
				runs: AcceptanceHistoryRun[];
			};
			const run = history.runs.find((candidate) => candidate.runId === runId);
			if (run?.terminalEvent?.type === terminalType) return run;
		}
		await Bun.sleep(50);
	}
	throw new Error(
		`Run ${runId} did not reach ${terminalType} in Conversation history`,
	);
}

let chat: Bun.Subprocess | undefined;
let runtimeProcess: Bun.Subprocess | undefined;
let redis: RedisTestServer | undefined;
let runtimePort: number;
let runtimeEnv: Record<string, string>;
let stopMaintenance: (() => Promise<void>) | undefined;

async function waitForRuntimeHealthy(timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const response = await fetch(`http://127.0.0.1:${runtimePort}/ping`, {
				signal: AbortSignal.timeout(1_000),
			});
			if (response.ok) return true;
		} catch {
			// The process may still be binding its health port.
		}
		await Bun.sleep(50);
	}
	return false;
}

async function startAgentCoreRuntime(
	overrides: Record<string, string> = {},
	healthFailureMessage = "deterministic AgentCore Runtime did not become healthy",
): Promise<void> {
	runtimeProcess = spawnAgentCoreRuntime({ ...runtimeEnv, ...overrides });
	expect(await waitForRuntimeHealthy(10_000), healthFailureMessage).toBe(true);
}

async function stopAgentCoreRuntime(): Promise<void> {
	const runningRuntime = runtimeProcess;
	runtimeProcess = undefined;
	if (!runningRuntime) return;
	runningRuntime.kill("SIGTERM");
	await runningRuntime.exited;
}

describe.skipIf(!RUN)("AgentCore integration (real Postgres and Redis)", () => {
	beforeAll(async () => {
		const dbUrl = DB_URL as string;
		if (configuredChatPort === undefined) chatPort = await findFreePort();
		CHAT_URL = `http://127.0.0.1:${chatPort}`;
		runtimePort = await findFreePort();
		redis = await startRedisTestServer({ stdio: "inherit" });
		const redisUrl = redis.url;
		stopMaintenance = startAgentCoreMaintenance(dbUrl);
		runtimeEnv = {
			AGENT_DATABASE_URL: dbUrl,
			REDIS_URL: redisUrl,
			LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS: "true",
			DB_SSL: "disable",
			LOG_LEVEL: "warn",
			INTEGRATION_RESUME_DELAY_MS: "1500",
			INTEGRATION_RUNTIME_PORT: String(runtimePort),
		};
		chat = Bun.spawn(["bun", "run", "local/index.ts"], {
			cwd: resolve(REPO_ROOT, "apps", "chat-api"),
			env: {
				...process.env,
				AGENT_DATABASE_URL: dbUrl,
				ARTIFACT_BUCKET: "mymemo-agent-integration-artifacts",
				AWS_REGION: "us-west-2",
				DB_SSL: "disable",
				REDIS_URL: redisUrl,
				LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS: "true",
				PORT: String(chatPort),
				LOG_LEVEL: "warn",
				// The local composition builds the Harness agent at boot; these are
				// never dialled because this suite does not post to /api/chat.
				E2B_API_KEY: "integration-e2b-key",
				OPENROUTER_API_KEY: "integration-openrouter-key",
				VERCEL_PROJECT_ID: "prj_integration",
				VERCEL_TEAM_ID: "team_integration",
				VERCEL_TOKEN: "integration-vercel-token",
			},
			stdout: "inherit",
			stderr: "inherit",
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
		await stopAgentCoreRuntime();
		await stopMaintenance?.();
		await redis?.stop();
	});

	it(
		"waits, disconnects, and reconnects an authorized AG-UI Run over real Redis",
		async () => {
			// Create the conversation (general scope). Proves migrations provisioned
			// the `conversations` table and chat-api's writable DB is reachable.
			const createRes = await fetch(`${CHAT_URL}/v1/conversations`, {
				method: "POST",
				headers: JSON_IDENTITY_HEADERS,
				body: JSON.stringify({}),
				signal: AbortSignal.timeout(15_000),
			});
			expect(
				createRes.status,
				"create conversation failed (response payload intentionally omitted)",
			).toBe(201);
			const conversationId = (
				(await createRes.json()) as { conversationId: string }
			).conversationId;
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
						content: "Hello from the AgentCore integration test.",
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
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify(runInput),
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				},
			);
			await waitForRunVisible(conversationId, runId, 10_000);

			const missingRun = await fetchRunEvents(
				conversationId,
				crypto.randomUUID(),
			);
			expect(missingRun.status).toBe(404);
			const foreignRun = await fetchRunEvents(conversationId, runId, {
				memberCode: "foreign-member",
			});
			expect(foreignRun.status).toBe(404);
			const reconnectPromise = fetchRunEvents(conversationId, runId, {
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});
			await Bun.sleep(5_200);
			await startAgentCoreRuntime(
				{},
				"deterministic AgentCore Runtime did not expose its health boundary",
			);

			const reconnect = await reconnectPromise;
			expect(reconnect.status).toBe(200);
			const textDisconnect = await readUntilSSEFrameAndCancel(
				reconnect,
				"TEXT_MESSAGE_CONTENT",
			);
			expect(textDisconnect.raw).toContain(": ping\n\n");
			expect(textDisconnect.frame.data.type).toBe("TEXT_MESSAGE_CONTENT");

			const afterTextResponse = await fetchRunEvents(conversationId, runId, {
				lastEventId: "not-a-cursor",
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});
			expect(afterTextResponse.status).toBe(200);
			const toolDisconnect = await readUntilSSEFrameAndCancel(
				afterTextResponse,
				"TOOL_CALL_ARGS",
			);

			const afterToolResponsePromise = fetchRunEvents(conversationId, runId, {
				lastEventId: "1-0",
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});

			const res = await runResponsePromise;
			expect(res.status, "unexpected Run response status").toBe(200);

			const [frames, afterToolResponse] = await Promise.all([
				consumeSSE(res, async () => {}),
				afterToolResponsePromise,
			]);
			expect(afterToolResponse.status).toBe(200);
			const afterToolFrames = parseAgUiSse(await afterToolResponse.text());
			const textDisconnectIndex = frames.findIndex(
				(frame) => frame.data.type === "TEXT_MESSAGE_CONTENT",
			);
			const toolDisconnectIndex = frames.findIndex(
				(frame) => frame.data.type === "TOOL_CALL_ARGS",
			);
			expect(textDisconnectIndex).toBe(2);
			expect(toolDisconnectIndex).toBe(5);
			expect(parseAgUiSse(toolDisconnect.raw)).toEqual(
				frames.slice(0, toolDisconnectIndex + 1),
			);
			expect(afterToolFrames).toEqual(frames);
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
			const textStart = requiredFrame(frames, "TEXT_MESSAGE_START").data;
			const toolStart = requiredFrame(frames, "TOOL_CALL_START").data;
			const toolArgs = requiredFrame(frames, "TOOL_CALL_ARGS").data;
			const toolEnd = requiredFrame(frames, "TOOL_CALL_END").data;
			const toolResult = requiredFrame(frames, "TOOL_CALL_RESULT").data;
			expect(toolStart).toMatchObject({
				parentMessageId: textStart.messageId,
				toolCallName: "Read",
			});
			expect(toolArgs.toolCallId).toBe(toolStart.toolCallId);
			expect(toolEnd.toolCallId).toBe(toolStart.toolCallId);
			expect(toolResult.toolCallId).toBe(toolStart.toolCallId);
			const streamedText = frames
				.filter((frame) => frame.data.type === "TEXT_MESSAGE_CONTENT")
				.map((frame) => frame.data.delta as string)
				.join("");
			expect(streamedText).toContain("Synthetic response");
			expect(streamedText).toContain(runId);
			expect(parseAgUiSse(textDisconnect.raw)).toEqual(
				frames.slice(0, textDisconnectIndex + 1),
			);

			const replayFromZero = await fetchRunEvents(conversationId, runId, {
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});
			expect(replayFromZero.status).toBe(410);
			expect(await replayFromZero.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});

			const historyResponse = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/history`,
				{
					headers: IDENTITY_HEADERS,
				},
			);
			expect(historyResponse.status).toBe(200);
			const history = (await historyResponse.json()) as {
				runs: Array<{
					runId: string;
					messages: Array<Record<string, unknown>>;
					terminalEvent: Record<string, unknown> | null;
				}>;
			};
			const historyRun = history.runs.find((run) => run.runId === runId);
			expect(historyRun).toEqual({
				runId,
				messages: [
					{
						id: "integration-user-message",
						role: "user",
						content: "Hello from the AgentCore integration test.",
					},
					{
						id: textStart.messageId,
						role: "assistant",
						content: streamedText,
						toolCalls: [
							{
								id: toolStart.toolCallId,
								type: "function",
								function: {
									name: "Read",
									arguments: '{"path":"CONTEXT.md"}',
								},
							},
						],
					},
					{
						id: toolResult.messageId,
						role: "tool",
						toolCallId: toolStart.toolCallId,
						content: '{"ok":true}',
					},
				],
				terminalEvent: {
					type: "RUN_FINISHED",
					threadId: conversationId,
					runId,
				},
			});

			const legacyHeaderReplay = await fetchRunEvents(conversationId, runId, {
				lastEventId: "9999999999999-0",
			});
			expect(legacyHeaderReplay.status).toBe(410);
			expect(await legacyHeaderReplay.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});

			const retry = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
				{
					method: "POST",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify(runInput),
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				},
			);
			expect(retry.status).toBe(410);
			expect(await retry.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});

			const mismatch = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
				{
					method: "POST",
					headers: JSON_IDENTITY_HEADERS,
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

			const failedRunId = crypto.randomUUID();
			const failedRun = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/runs`,
				{
					method: "POST",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify({
						...runInput,
						runId: failedRunId,
						messages: [
							{
								id: "integration-tool-error-message",
								role: "user",
								content: "Synthetic tool-only failure",
							},
						],
					}),
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				},
			);
			expect(failedRun.status).toBe(200);
			const failedFrames = parseAgUiSse(await failedRun.text());
			expect(failedFrames.map((frame) => frame.data.type)).toEqual([
				"RUN_STARTED",
				"TOOL_CALL_START",
				"TOOL_CALL_ARGS",
				"TOOL_CALL_END",
				"TOOL_CALL_RESULT",
				"CUSTOM",
				"RUN_FINISHED",
			]);
			const failedStart = requiredFrame(failedFrames, "TOOL_CALL_START").data;
			const failedResult = requiredFrame(failedFrames, "TOOL_CALL_RESULT").data;
			expect(failedResult).toMatchObject({
				toolCallId: failedStart.toolCallId,
				content: "Tool failed",
			});
			expect(requiredFrame(failedFrames, "CUSTOM").data).toEqual({
				type: "CUSTOM",
				name: "mymemo.tool_result_error",
				value: {
					messageId: failedResult.messageId,
					toolCallId: failedStart.toolCallId,
				},
			});
			const failedReplay = await fetchRunEvents(conversationId, failedRunId, {
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});
			expect(failedReplay.status).toBe(410);
			expect(await failedReplay.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});
			const failedLegacyHeaderReplay = await fetchRunEvents(
				conversationId,
				failedRunId,
				{
					lastEventId: "3-0",
					signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
				},
			);
			expect(failedLegacyHeaderReplay.status).toBe(410);
			expect(await failedLegacyHeaderReplay.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});

			const failedHistoryResponse = await fetch(
				`${CHAT_URL}/v1/conversations/${conversationId}/history`,
				{
					headers: IDENTITY_HEADERS,
				},
			);
			const failedHistory = (await failedHistoryResponse.json()) as {
				runs: Array<{
					runId: string;
					messages: Array<Record<string, unknown>>;
				}>;
			};
			const failedHistoryRun = failedHistory.runs.find(
				(run) => run.runId === failedRunId,
			);
			expect(failedHistoryRun?.messages).toEqual([
				{
					id: "integration-tool-error-message",
					role: "user",
					content: "Synthetic tool-only failure",
				},
				{
					id: failedStart.parentMessageId,
					role: "assistant",
					toolCalls: [
						{
							id: failedStart.toolCallId,
							type: "function",
							function: {
								name: "Read",
								arguments: '{"path":"CONTEXT.md"}',
							},
						},
					],
				},
				{
					id: failedResult.messageId,
					role: "tool",
					toolCallId: failedStart.toolCallId,
					content: "Tool failed",
					error: "Tool failed",
				},
			]);
		},
		TURN_TIMEOUT_MS + 15_000,
	);

	it(
		"interrupts a running Run through HTTP while its client reconnects",
		async () => {
			await stopAgentCoreRuntime();
			const turn = await admitIntegrationRun(
				"Synthetic text-only lifecycle scenario",
			);
			await startAgentCoreRuntime({
				INTEGRATION_RESUME_DELAY_MS: "6000",
			});

			const response = await turn.response;
			expect(response.status).toBe(200);
			await readUntilSSEFrameAndCancel(response, "TEXT_MESSAGE_CONTENT");

			const archiveWhileActive = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}`,
				{
					method: "PATCH",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify({ archived: true }),
				},
			);
			expect(archiveWhileActive.status).toBe(409);

			const deleteWhileActive = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}`,
				{
					method: "DELETE",
					headers: IDENTITY_HEADERS,
				},
			);
			expect(deleteWhileActive.status).toBe(409);

			const renameWhileActive = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}`,
				{
					method: "PATCH",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify({ title: "Renamed while active" }),
				},
			);
			expect(renameWhileActive.status).toBe(200);

			const competingRunId = crypto.randomUUID();
			const competingAdmission = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}/runs`,
				{
					method: "POST",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify({
						threadId: turn.conversationId,
						runId: competingRunId,
						state: {},
						messages: [
							{
								id: `user-${competingRunId}`,
								role: "user",
								content: "Competing active work",
							},
						],
						tools: [],
						context: [],
						forwardedProps: {},
					}),
				},
			);
			expect(competingAdmission.status).toBe(409);

			const resumed = await fetchRunEvents(turn.conversationId, turn.runId, {
				lastEventId: "legacy-cursor",
				signal: AbortSignal.timeout(TURN_TIMEOUT_MS),
			});
			expect(resumed.status).toBe(200);

			const interruption = await interruptRun(turn.conversationId, turn.runId);
			expect(interruption.status).toBe(202);
			expect(await interruption.json()).toEqual({
				runId: turn.runId,
				status: "interrupt_requested",
			});

			const resumedFrames = parseAgUiSse(await resumed.text());
			expect(resumedFrames.at(-1)?.data.type).toBe("RUN_INTERRUPTED");
			expect(
				resumedFrames.some((frame) => frame.data.type === "RUN_FINISHED"),
			).toBe(false);

			const historyRun = await waitForHistoryRun(
				turn.conversationId,
				turn.runId,
				"RUN_INTERRUPTED",
				TURN_TIMEOUT_MS,
			);
			expect(historyRun.messages).toEqual([
				{
					id: `user-${turn.runId}`,
					role: "user",
					content: "Synthetic text-only lifecycle scenario",
				},
			]);

			const archiveAfterInterrupt = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}`,
				{
					method: "PATCH",
					headers: JSON_IDENTITY_HEADERS,
					body: JSON.stringify({ archived: true }),
				},
			);
			expect(archiveAfterInterrupt.status).toBe(200);

			const deleteAfterInterrupt = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}`,
				{
					method: "DELETE",
					headers: IDENTITY_HEADERS,
				},
			);
			expect(deleteAfterInterrupt.status).toBe(204);
			const deletedHistory = await fetch(
				`${CHAT_URL}/v1/conversations/${turn.conversationId}/history`,
				{
					headers: IDENTITY_HEADERS,
				},
			);
			expect(deletedHistory.status).toBe(404);
		},
		TURN_TIMEOUT_MS + 15_000,
	);

	it(
		"keeps queued interruption and Reclamation free of fabricated Live Streams",
		async () => {
			await stopAgentCoreRuntime();
			const queued = await admitIntegrationRun(
				"Interrupt before durable acquisition",
			);
			const interruption = await interruptRun(
				queued.conversationId,
				queued.runId,
			);
			expect(interruption.status).toBe(202);
			expect(await interruption.json()).toEqual({
				runId: queued.runId,
				status: "interrupted",
			});
			// Retry-safe across the terminal transition (ADR-0013): the queued
			// interruption already won, so a lost-response retry stays a success.
			const retriedInterruption = await interruptRun(
				queued.conversationId,
				queued.runId,
			);
			expect(retriedInterruption.status).toBe(202);
			expect(await retriedInterruption.json()).toEqual({
				runId: queued.runId,
				status: "interrupted",
			});
			const queuedResponse = await queued.response;
			expect(queuedResponse.status).toBe(410);
			expect(await queuedResponse.json()).toEqual({
				error: "Live stream unavailable",
				recovery: "history",
			});
			const queuedHistory = await waitForHistoryRun(
				queued.conversationId,
				queued.runId,
				"RUN_INTERRUPTED",
				TURN_TIMEOUT_MS,
			);
			expect(queuedHistory.terminalEvent?.type).toBe("RUN_INTERRUPTED");
			const queuedRecovery = await fetchRunEvents(
				queued.conversationId,
				queued.runId,
			);
			expect(queuedRecovery.status).toBe(410);

			const stale = await admitIntegrationRun("Synthetic stale Runtime crash");
			runtimeProcess = spawnAgentCoreRuntime(runtimeEnv);
			const crashedRuntime = runtimeProcess;
			expect(await crashedRuntime.exited).toBe(17);
			runtimeProcess = undefined;

			// The separate Release 1 maintenance actor must establish the durable
			// Outcome while the crashed Runtime stays down.
			const staleHistory = await waitForHistoryRun(
				stale.conversationId,
				stale.runId,
				"RUN_ERROR",
				TURN_TIMEOUT_MS,
			);
			expect(staleHistory.terminalEvent?.type).toBe("RUN_ERROR");
			await stopAgentCoreRuntime();
			const staleResponse = await stale.response;
			expect(staleResponse.status).toBe(200);
			const staleFrames = parseAgUiSse(await staleResponse.text());
			expect(staleFrames.some((frame) => frame.data.type === "RUN_ERROR")).toBe(
				false,
			);
			const staleRecovery = await fetchRunEvents(
				stale.conversationId,
				stale.runId,
			);
			expect(staleRecovery.status).toBe(410);
		},
		TURN_TIMEOUT_MS * 2 + 15_000,
	);
});
