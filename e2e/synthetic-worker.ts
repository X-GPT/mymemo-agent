/**
 * Test-only Run processor for the credential-free Postgres/Redis integration.
 * Production never imports this file: the real agent-worker entrypoint always
 * runs the Claude Agent SDK. This fixture keeps the queue → durable history →
 * retained AG-UI Stream seam deterministic; Task 9.7 owns the credentialed
 * live smoke for the production worker.
 */
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

const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
const workerId = "integration-event-writer";
const worker = new Worker({
	workerId,
	maxConcurrentRuns: 1,
	shutdownTimeoutMs: 1_000,
	logger,
});
const redisLiveStreamStore = createRedisLiveStreamStore({
	url: redisUrl,
	deployment: "current",
});
const liveStreamStore = withInjectedRedisFault(
	redisLiveStreamStore,
	process.env.INTEGRATION_LIVE_STREAM_FAIL_AT,
);
const resumeDelayMs = Number(process.env.INTEGRATION_RESUME_DELAY_MS ?? 0);
const processor: RunProcessor = async (ctx) => {
	const messageId = `message-${ctx.run.runId}`;
	const toolCallId = `tool-${ctx.run.runId}`;
	const toolResultMessageId = `tool-result-${ctx.run.runId}`;
	const toolOnlyFailure =
		ctx.run.normalizedInput?.text === "Synthetic tool-only failure";
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
	db: createDatabase(agentDatabaseUrl),
	worker,
	processor,
	liveStreamStore,
	heartbeatIntervalMs: 500,
	logger,
});

runLoop.start();

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await runLoop.stop();
	await liveStreamStore.close();
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
