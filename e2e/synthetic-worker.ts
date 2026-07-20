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
import { createRedisLiveStreamStore } from "../packages/live-text/src/redis-live-stream-store";

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
const liveStreamStore = createRedisLiveStreamStore({
	url: redisUrl,
	deployment: "current",
});
const resumeDelayMs = Number(process.env.INTEGRATION_RESUME_DELAY_MS ?? 0);
const processor: RunProcessor = async (ctx) => {
	const messageId = `message-${ctx.run.runId}`;
	const toolCallId = `tool-${ctx.run.runId}`;
	const text = `Synthetic response for run ${ctx.run.runId}`;
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
	await ctx.appendModelContent({
		kind: "assistant_message",
		payload: {
			messageId,
			text,
		},
	});
	await ctx.appendLiveEvent({ type: "TEXT_MESSAGE_END", messageId });
	await ctx.appendModelContent({
		kind: "tool_use",
		payload: {
			tool: "Read",
			arguments: { path: "CONTEXT.md" },
			truncated: false,
		},
	});
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
		kind: "tool_result",
		payload: {
			tool: "Read",
			result: { ok: true },
			isError: false,
			truncated: false,
		},
	});
	await ctx.appendLiveEvent({
		type: "TOOL_CALL_RESULT",
		messageId: `tool-result-${ctx.run.runId}`,
		toolCallId,
		content: '{"ok":true}',
		role: "tool",
	});
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
