import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import { sweepStaleProcessingTurnsTx } from "@mymemo/agent-db/turn-store";
import { PostgresDocumentAccessLog } from "@mymemo/document-tools/access-log";
import { createKbDb } from "@mymemo/document-tools/client";
import type { TurnLiveStreamRelay } from "@mymemo/live-text";
import { createRedisTurnLiveStreamRelay } from "@mymemo/live-text";
import pino from "pino";
import { createAgentSession } from "./agent-session";
import { createApp } from "./app";
import { resolveAndVerifyClaudeCodeExecutable } from "./claude-code-executable";
import {
	type Env,
	envFromRunHookPayload,
	loadInVmConfigFromEnv,
} from "./config";
import { type CurrentTurn, createDocToolsServer } from "./doc-tools";
import { type DrainLoopHandle, startDrainLoop } from "./drain-loop";
import { buildTurnQueryOptions } from "./query-options";
import type { TurnServingDeps } from "./turn-serving";

// Entrypoint: the only place that reads the environment. One VM serves one
// Conversation. Two delivery modes, one configuration contract (#662/#666):
// locally the full config is env vars and the server configures at startup;
// in the MicroVM the image boots unconfigured (the image build's /ready hook
// fires with no Conversation at all) and the platform /run hook delivers the
// same env-shaped keys via runHookPayload. `bun run src/index.ts` serves this
// default export under Bun either way.
const processEnv = Bun.env;
const logger = pino({ level: processEnv.LOG_LEVEL || "info" });

const port = processEnv.PORT === undefined ? 8080 : Number(processEnv.PORT);
if (!(Number.isSafeInteger(port) && port > 0)) {
	throw new Error("PORT must be a positive integer");
}

let serving: { loop: DrainLoopHandle; relay: TurnLiveStreamRelay } | null =
	null;

/**
 * Build the Turn-serving dependencies from env-shaped config, run the boot
 * sweep, and start the drain loop (#664), which resumes draining queued rows
 * without a nudge. Any failure — bad payload, unresolvable CLI binary, an
 * unreachable data plane at the awaited sweep — throws before the loop
 * starts, so a failed /run answers non-200 and leaves the server
 * unconfigured for a retry instead of wedging a "serving" VM.
 */
async function configure(env: Env): Promise<void> {
	const config = loadInVmConfigFromEnv(env);
	const relay = createRedisTurnLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
	});
	const db = createDatabase(config.databaseUrl);
	const currentTurn: CurrentTurn = { turnId: null };
	const queryOptions = buildTurnQueryOptions({
		workspaceDir: config.workspaceDir,
		model: config.model,
		processEnv,
		pathToClaudeCodeExecutable: resolveAndVerifyClaudeCodeExecutable(),
		docToolsServer: createDocToolsServer({
			db,
			kb: createKbDb(config.kbDatabaseUrl),
			audit: new PostgresDocumentAccessLog(db),
			logger,
			userId: config.userId,
			conversationId: config.conversationId,
			workspaceDir: config.workspaceDir,
			currentTurn,
		}),
	});
	const deps: TurnServingDeps = {
		db,
		relay,
		userId: config.userId,
		conversationId: config.conversationId,
		// ONE long-lived query() carries the Agent session across Turns (#664).
		query: createAgentSession({ query, options: queryOptions }),
		queryOptions,
		currentTurn,
		logger,
	};
	// One awaited sweep before the loop starts: stale `processing` Turns are
	// `interrupted` before /run answers 200, and an unreachable database fails
	// the launch loudly. The loop's own retried sweep then finds nothing —
	// sweeping is idempotent.
	const swept = await sweepStaleProcessingTurnsTx(deps.db, {
		userId: config.userId,
		conversationId: config.conversationId,
	});
	if (swept.length > 0) {
		logger.warn(
			{ conversationId: config.conversationId, messageIds: swept },
			"boot sweep terminalized stale processing Turns as interrupted",
		);
	}
	serving = { loop: startDrainLoop(deps), relay };
}

const app = createApp({
	nudge: () => {
		if (!serving) return false;
		serving.loop.nudge();
		return true;
	},
	run: async ({ microvmId, runHookPayload }) => {
		if (serving) {
			// The platform delivers /run once per launch; a repeat is harmless
			// because the VM is already serving its Conversation.
			logger.warn({ microvmId }, "run hook repeated; already configured");
			return;
		}
		// A configure failure throws into Hono's 500 — the non-200 run hook
		// keeps the platform from ever routing traffic to this VM.
		await configure({
			...processEnv,
			...envFromRunHookPayload(runHookPayload),
		});
		logger.info({ microvmId }, "configured from runHookPayload; serving");
	},
	// Baked by the image (SMOKE_SCRIPT=/opt/microvm/smoke.sh); unset locally,
	// so the route only exists in-VM.
	smokeScriptPath: processEnv.SMOKE_SCRIPT,
});

// Local/dev mode: the Conversation identity in the plain environment selects
// immediate configuration, exactly as #662/#664 shipped it.
if (processEnv.MYMEMO_CONVERSATION_ID) {
	await configure(processEnv);
}

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await serving?.relay.close().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

export default { port, fetch: app.fetch };
