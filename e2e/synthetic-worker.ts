/**
 * Test-only Run processor for the credential-free Postgres/Redis integration.
 * Production never imports this file: the real agent-worker entrypoint always
 * runs the Claude Agent SDK. This fixture keeps the queue → durable history →
 * retained AG-UI Stream seam deterministic; Task 9.7 owns the credentialed
 * live smoke for the production worker.
 */

import { startHealthServer } from "../apps/agent-worker/src/health";
import { createLogger } from "../apps/agent-worker/src/logger";
import { RunLoop, type RunProcessor } from "../apps/agent-worker/src/run-loop";
import { Worker } from "../apps/agent-worker/src/worker";
import { createDatabase } from "../packages/agent-db/src/client";
import {
	createRedisLiveStreamStore,
	type LiveStreamStore,
} from "../packages/live-text/src/redis-live-stream-store";

const agentDatabaseUrl = process.env.AGENT_DATABASE_URL;
if (!agentDatabaseUrl) throw new Error("AGENT_DATABASE_URL is required");
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const healthPort = Number(process.env.INTEGRATION_WORKER_PORT);
if (!Number.isInteger(healthPort) || healthPort < 1) {
	throw new Error("INTEGRATION_WORKER_PORT is required");
}
const retentionMs = optionalPositiveInteger(
	process.env.INTEGRATION_LIVE_STREAM_RETENTION_MS,
);
const maxEvents = optionalPositiveInteger(
	process.env.INTEGRATION_LIVE_STREAM_MAX_EVENTS,
);
const maxStreamBytes = optionalPositiveInteger(
	process.env.INTEGRATION_LIVE_STREAM_MAX_BYTES,
);
const heartbeatIntervalMs =
	optionalPositiveInteger(process.env.INTEGRATION_HEARTBEAT_INTERVAL_MS) ?? 500;

const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
const workerId = "integration-event-writer";
const worker = new Worker({
	workerId,
	maxConcurrentRuns: 1,
	shutdownTimeoutMs: 1_000,
	logger,
});
const healthServer = startHealthServer(worker, healthPort, logger);
const database = createDatabase(agentDatabaseUrl);
const redisLiveStreamStore = createRedisLiveStreamStore({
	url: redisUrl,
	deployment: "current",
	...(retentionMs !== undefined ||
	maxEvents !== undefined ||
	maxStreamBytes !== undefined
		? {
				testLimits: {
					...(retentionMs === undefined ? {} : { retentionMs }),
					...(maxEvents === undefined ? {} : { maxEvents }),
					...(maxStreamBytes === undefined ? {} : { maxStreamBytes }),
				},
			}
		: {}),
});
const liveStreamStore = withInjectedRedisFault(
	redisLiveStreamStore,
	process.env.INTEGRATION_LIVE_STREAM_FAIL_AT,
);
const resumeDelayMs = Number(process.env.INTEGRATION_RESUME_DELAY_MS ?? 0);

type SyntheticScenario =
	| "text_and_tool"
	| "text_only"
	| "tool_failure"
	| "stale_crash";

function resolveSyntheticScenario(text: string | undefined): SyntheticScenario {
	if (text === "Synthetic stale worker crash") return "stale_crash";
	if (text === "Synthetic tool-only failure") return "tool_failure";
	if (text?.startsWith("Synthetic text-only")) return "text_only";
	return "text_and_tool";
}

const processor: RunProcessor = async (ctx) => {
	const scenario = resolveSyntheticScenario(ctx.run.normalizedInput?.text);
	if (scenario === "stale_crash") {
		await database.$client.query(
			"update runs set locked_until = now() - interval '1 second' where run_id = $1 and locked_by = $2",
			[ctx.run.runId, workerId],
		);
		process.exit(17);
	}
	const messageId = `message-${ctx.run.runId}`;
	const toolCallId = `tool-${ctx.run.runId}`;
	const toolResultMessageId = `tool-result-${ctx.run.runId}`;
	const toolOnlyFailure = scenario === "tool_failure";
	const textOnly = scenario === "text_only";
	const text = `Synthetic response for run ${ctx.run.runId}`;
	if (!toolOnlyFailure) {
		await ctx.appendLiveEvent({
			type: "TEXT_MESSAGE_START",
			messageId,
			role: "assistant",
		});
		await ctx.appendLiveEvent({
			type: "TEXT_MESSAGE_CONTENT",
			messageId,
			delta: text,
		});
		if (resumeDelayMs > 0) await Bun.sleep(resumeDelayMs);
	}
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: {
			messageId,
			text: toolOnlyFailure ? "" : text,
		},
	});
	if (!toolOnlyFailure) {
		await ctx.appendLiveEvent({ type: "TEXT_MESSAGE_END", messageId });
	}
	if (textOnly) return;
	await ctx.appendModelContents([
		{
			kind: "tool_call_started",
			payload: {
				toolCallId,
				toolCallName: "Read",
				parentMessageId: messageId,
			},
		},
		{
			kind: "tool_call_args",
			payload: { toolCallId, delta: '{"path":"CONTEXT.md"}' },
		},
		{
			kind: "tool_call_completed",
			payload: { toolCallId },
		},
	]);
	await ctx.appendLiveEvent({
		type: "TOOL_CALL_START",
		toolCallId,
		toolCallName: "Read",
		parentMessageId: messageId,
	});
	await ctx.appendLiveEvent({
		type: "TOOL_CALL_ARGS",
		toolCallId,
		delta: '{"path":"CONTEXT.md"}',
	});
	if (resumeDelayMs > 0) await Bun.sleep(resumeDelayMs);
	await ctx.appendLiveEvent({ type: "TOOL_CALL_END", toolCallId });
	await ctx.appendModelContent({
		kind: "tool_call_result",
		payload: {
			messageId: toolResultMessageId,
			toolCallId,
			content: toolOnlyFailure ? "Tool failed" : '{"ok":true}',
			isError: toolOnlyFailure,
		},
	});
	await ctx.appendLiveEvent({
		type: "TOOL_CALL_RESULT",
		messageId: toolResultMessageId,
		toolCallId,
		content: toolOnlyFailure ? "Tool failed" : '{"ok":true}',
		role: "tool",
	});
	if (toolOnlyFailure) {
		await ctx.appendLiveEvent({
			type: "CUSTOM",
			name: "mymemo.tool_result_error",
			value: { messageId: toolResultMessageId, toolCallId },
		});
	}
};
const runLoop = new RunLoop({
	db: database,
	worker,
	processor,
	liveStreamStore,
	heartbeatIntervalMs,
	logger,
});

runLoop.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await runLoop.stop();
	await liveStreamStore.close();
	await database.$client.end();
	healthServer.stop();
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

type LiveStreamFault = "before_creation" | "mid_text" | "tool" | "terminal";

/** Deterministically faults one operation while retaining a real Redis-backed
 * store for every operation on either side of the failure. Integration tests
 * use this to cover process-boundary recovery without timing Redis shutdowns. */
function withInjectedRedisFault(
	store: LiveStreamStore,
	rawFault: string | undefined,
): LiveStreamStore {
	const fault = isLiveStreamFault(rawFault) ? rawFault : undefined;
	let injected = false;
	const inject = (candidate: LiveStreamFault) => {
		if (fault !== candidate || injected) return;
		injected = true;
		throw new Error(`injected Redis failure at ${candidate}`);
	};
	return {
		async acquire(streamId, options) {
			inject("before_creation");
			return store.acquire(streamId, options);
		},
		async append(streamId, chunk) {
			const type = liveEventType(chunk);
			if (type === "TEXT_MESSAGE_CONTENT") inject("mid_text");
			if (type === "TOOL_CALL_START") inject("tool");
			if (type === "RUN_FINISHED") inject("terminal");
			return store.append(streamId, chunk);
		},
		appendWithRetryId(streamId, retryId, chunk) {
			return store.appendWithRetryId(streamId, retryId, chunk);
		},
		finalize(streamId, status, error) {
			return store.finalize(streamId, status, error);
		},
		refresh(streamId) {
			return store.refresh(streamId);
		},
		read(streamId, cursor, signal) {
			return store.read(streamId, cursor, signal);
		},
		status(streamId) {
			return store.status(streamId);
		},
		delete(streamId) {
			return store.delete(streamId);
		},
		close() {
			return store.close();
		},
	};
}

function isLiveStreamFault(
	value: string | undefined,
): value is LiveStreamFault {
	return (
		value === "before_creation" ||
		value === "mid_text" ||
		value === "tool" ||
		value === "terminal"
	);
}

function liveEventType(chunk: Uint8Array): string | undefined {
	try {
		const event = JSON.parse(new TextDecoder().decode(chunk)) as {
			type?: unknown;
		};
		return typeof event.type === "string" ? event.type : undefined;
	} catch {
		return undefined;
	}
}

function optionalPositiveInteger(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error("integration limits must be positive integers");
	}
	return value;
}
