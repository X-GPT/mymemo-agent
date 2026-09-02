import { homedir } from "node:os";
import path from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import {
	hasQueuedTurnsTx,
	sweepStaleProcessingTurnsTx,
} from "@mymemo/agent-db/turn-store";
import { PostgresDocumentAccessLog } from "@mymemo/document-tools/access-log";
import { createKbDb } from "@mymemo/document-tools/client";
import type { TurnLiveStreamRelay } from "@mymemo/live-text";
import { createRedisTurnLiveStreamRelay } from "@mymemo/live-text";
import pino from "pino";
import { createAgentSession, hasTranscript } from "./agent-session";
import { createApp } from "./app";
import {
	type CheckpointDoor,
	restoreCheckpoint,
	saveCheckpoint,
} from "./checkpoint";
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

// The runtime user's HOME: `.claude` under it is the Agent session the
// Checkpoint carries (#670).
const homeDir = homedir();

let serving: {
	loop: DrainLoopHandle;
	relay: TurnLiveStreamRelay;
	/** The suspend-time Checkpoint write; null outside the MicroVM. */
	checkpoint: (() => Promise<void>) | null;
	/** The suspend hook's strand check: work the parked loop is holding back. */
	hasQueuedTurns: () => Promise<boolean>;
} | null = null;

/**
 * Build the Turn-serving dependencies from env-shaped config, restore the
 * Checkpoint (#670), run the boot sweep, and start the drain loop (#664),
 * which resumes draining queued rows without a nudge. Any failure — bad
 * payload, a Checkpoint that would not restore, unresolvable CLI binary, an
 * unreachable data plane at the awaited sweep — throws before the loop
 * starts, so a failed /run answers non-200 and leaves the server
 * unconfigured for a retry instead of wedging a "serving" VM.
 */
async function configure(env: Env, microvmId?: string): Promise<void> {
	const config = loadInVmConfigFromEnv(env);
	const paths = { homeDir, workspaceDir: config.workspaceDir };
	// The Checkpoint door exists only in the MicroVM (the payload names it and
	// the run hook names the VM); a local run neither restores nor saves. A
	// payload that names the door without a VM id fails the launch: serving
	// without the door would silently forfeit durability.
	if (config.checkpointUrl && !microvmId) {
		throw new Error(
			"CHECKPOINT_URL is set but the run hook named no microvmId",
		);
	}
	const door: CheckpointDoor | null =
		config.checkpointUrl && microvmId
			? { url: config.checkpointUrl, token: config.model.apiKey, microvmId }
			: null;
	if (door) {
		// Before anything reads the Workspace or the session — and before the
		// platform routes traffic: the VM is never ready with stale state.
		await restoreCheckpoint(paths, door, logger);
	}
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
	// ONE long-lived query() carries the Agent session across Turns (#664),
	// pinned to the Conversation id so a restored transcript resumes (#670).
	const sessionId = config.conversationId;
	const claudeDir = path.join(homeDir, ".claude");
	const deps: TurnServingDeps = {
		db,
		relay,
		userId: config.userId,
		conversationId: config.conversationId,
		query: createAgentSession({
			query,
			options: queryOptions,
			session: {
				id: sessionId,
				hasTranscript: () => hasTranscript(claudeDir, sessionId),
			},
		}),
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
	serving = {
		loop: startDrainLoop(deps),
		relay,
		checkpoint: door ? () => saveCheckpoint(paths, door, logger) : null,
		hasQueuedTurns: () => hasQueuedTurnsTx(db, deps),
	};
}

const app = createApp({
	nudge: async (command) => {
		if (!serving) return false;
		// The command applies before the doorbell rings, so a still-queued
		// target cannot be claimed by the nudge it arrived on.
		if (command) await serving.loop.interrupt(command.interrupt);
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
		// Log before configuring: the platform's runTimeoutInSeconds terminates
		// the VM if configure outlasts it, and this line is then the only
		// in-VM evidence the hook arrived (learned live on #666).
		logger.info({ microvmId }, "run hook received; configuring");
		// A configure failure throws into Hono's 500 — the non-200 run hook
		// keeps the platform from ever routing traffic to this VM.
		await configure(
			{
				...processEnv,
				...envFromRunHookPayload(runHookPayload),
			},
			microvmId,
		);
		logger.info({ microvmId }, "configured from runHookPayload; serving");
	},
	suspend: async () => {
		// Unconfigured (the image build, or a suspend racing /run) or doorless
		// (never in the MicroVM): nothing to drain or save.
		if (!serving?.checkpoint) return;
		const started = Date.now();
		// The graceful-drain gate: holds while a Turn is processing.
		await serving.loop.pause();
		logger.info(
			{ heldMs: Date.now() - started },
			"suspend hook: drained; checkpointing",
		);
		try {
			await serving.checkpoint();
			if (await serving.hasQueuedTurns()) {
				// A Turn is queued behind the hold (arrived during it, or behind the
				// Turn that was in flight): suspending now would strand it until the
				// next message. The Checkpoint landed; refuse the suspend and drain.
				throw new Error("a Turn is queued behind the suspend hold");
			}
		} catch (error) {
			// The platform sees non-200. Should it keep the VM running, serving
			// must continue rather than sit parked behind a hook that failed.
			serving.loop.resume();
			throw error;
		}
	},
	resume: async () => {
		serving?.loop.resume();
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
