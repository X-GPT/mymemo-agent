/**
 * Test-only AgentCore Runtime for the credential-free Postgres/Redis
 * integration suite. It replaces AWS queue transport with a local outbox poll,
 * but
 * keeps dispatch publication, durable acquisition, Runtime invocation,
 * shared Run-serving, and the Live Stream on production seams. Global
 * expiration and Reclamation remain outside the Runtime process.
 */

import { createLogger, toMessage } from "../apps/agent-worker/src/logger";
import {
	createRunServing,
	type RunProcessor,
} from "../apps/agent-worker/src/run-serving";
import { createAgentCoreAcquisitionBoundary } from "../apps/agentcore-dispatch-consumer/src/acquisition-boundary";
import { serializeAgentCoreDispatchEnvelope } from "../apps/agentcore-dispatch-consumer/src/contract";
import { createAgentCoreExecutionServices } from "../apps/agentcore-runtime/src/execution-services";
import { createAgentCoreRuntime } from "../apps/agentcore-runtime/src/runtime";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	startRuntimeServer,
} from "../apps/agentcore-runtime/src/server";
import {
	acquireAgentCoreDispatchTx,
	claimAgentCoreDispatchesTx,
	confirmAgentCoreDispatchPublishedTx,
} from "../packages/agent-db/src/agentcore-dispatch";
import { createDatabase } from "../packages/agent-db/src/client";
import { createRedisLiveStreamRelay } from "../packages/live-text/src";

const agentDatabaseUrl = process.env.AGENT_DATABASE_URL;
if (!agentDatabaseUrl) throw new Error("AGENT_DATABASE_URL is required");
const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is required");
const runtimePort = Number(process.env.INTEGRATION_RUNTIME_PORT);
if (!Number.isInteger(runtimePort) || runtimePort < 1) {
	throw new Error("INTEGRATION_RUNTIME_PORT is required");
}
const heartbeatIntervalMs =
	optionalPositiveInteger(process.env.INTEGRATION_HEARTBEAT_INTERVAL_MS) ?? 500;

const logger = createLogger(process.env.LOG_LEVEL ?? "warn");
const runtimeId = `integration-agentcore-${crypto.randomUUID()}`;
const publisherId = `${runtimeId}/publisher`;
const database = createDatabase(agentDatabaseUrl);
const liveStreamRelay = createRedisLiveStreamRelay({
	url: redisUrl,
	deployment: "current",
});
const resumeDelayMs = Number(process.env.INTEGRATION_RESUME_DELAY_MS ?? 0);

type SyntheticScenario =
	| "text_and_tool"
	| "text_only"
	| "tool_failure"
	| "stale_crash";

function resolveSyntheticScenario(text: string | undefined): SyntheticScenario {
	if (text === "Synthetic stale Runtime crash") return "stale_crash";
	if (text === "Synthetic tool-only failure") return "tool_failure";
	if (text?.startsWith("Synthetic text-only")) return "text_only";
	return "text_and_tool";
}

const processor: RunProcessor = async (ctx) => {
	const scenario = resolveSyntheticScenario(ctx.run.normalizedInput?.text);
	if (scenario === "stale_crash") {
		await database.$client.query(
			"update conversations set owner_until = now() - interval '1 second' where user_id = $1 and conversation_id = $2 and owner_worker_id = $3",
			[ctx.run.userId, ctx.run.conversationId, ctx.owner.workerId],
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
const runServing = createRunServing({
	db: database,
	processor,
	liveStreamRelay,
	logger,
});
const acquisition = createAgentCoreAcquisitionBoundary({
	control: {
		async isEnabled() {
			return true;
		},
	},
	acquire: async (input) => await acquireAgentCoreDispatchTx(database, input),
	createWorkerId: () => `${runtimeId}/${crypto.randomUUID()}`,
});
const services = createAgentCoreExecutionServices({
	db: database,
	acquire: acquisition.acquireDispatch,
	runServing,
	logger,
});
const runtime = createAgentCoreRuntime({
	...services,
	heartbeatIntervalMs,
	onExecutionError(error, dispatch) {
		logger.error({
			message: "test AgentCore execution abandoned",
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			error: toMessage(error),
		});
	},
});
const runtimeServer = startRuntimeServer(runtime, runtimePort);

async function invokeNextDispatch(): Promise<void> {
	if (runtime.health().status === "HealthyBusy") return;
	const [dispatch] = await claimAgentCoreDispatchesTx(database, {
		publisherId,
		limit: 1,
	});
	if (!dispatch) return;
	if (
		!(await confirmAgentCoreDispatchPublishedTx(database, {
			runId: dispatch.runId,
			publisherId,
		}))
	) {
		throw new Error("test Dispatch publication lost its outbox lease");
	}
	const response = await fetch(`http://127.0.0.1:${runtimePort}/invocations`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[AGENTCORE_RUNTIME_SESSION_HEADER]: dispatch.runtimeSessionId,
		},
		body: serializeAgentCoreDispatchEnvelope(dispatch),
	});
	if (!response.ok) {
		throw new Error(`test AgentCore invocation returned ${response.status}`);
	}
	// AgentCore execution continues after its acquisition receipt stream closes.
	await response.body?.cancel();
}

let shuttingDown = false;
let activeTick = Promise.resolve();
let tickTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleTick(delayMs = heartbeatIntervalMs): void {
	if (shuttingDown) return;
	tickTimer = setTimeout(() => {
		activeTick = runTick();
	}, delayMs);
}

async function runTick(): Promise<void> {
	try {
		await invokeNextDispatch();
	} catch (error) {
		logger.error({
			message: "test AgentCore dispatch tick failed",
			error: toMessage(error),
		});
	} finally {
		scheduleTick();
	}
}

scheduleTick(0);

async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	if (tickTimer) clearTimeout(tickTimer);
	await activeTick;
	await runtime.shutdown();
	await liveStreamRelay.close();
	await database.$client.end();
	runtimeServer.stop(true);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function optionalPositiveInteger(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error("integration limits must be positive integers");
	}
	return value;
}
