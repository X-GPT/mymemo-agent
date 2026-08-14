import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
} from "@mymemo/live-text";
import { createArtifactPublisher } from "./artifacts/artifact-publication";
import { createS3ArtifactObjectStore } from "./artifacts/s3-artifact-object-store";
import type { AdvisoryLockPool } from "./cleanup/advisory-lock";
import { CleanupLoop } from "./cleanup/cleanup-loop";
import { createE2bSandboxJanitor } from "./cleanup/e2b-janitor";
import { createS3ArtifactObjectJanitor } from "./cleanup/s3-artifact-janitor";
import { loadWorkerConfigFromEnv } from "./config/env";
import { createDocumentSearch } from "./documents/client";
import { createE2bSandboxProvisioner } from "./e2b/sandbox-provisioner";
import { startHealthServer } from "./health";
import { createLogger } from "./logger";
import { buildModelClientConfig } from "./model-client";
import { PostgresRunDoorbell } from "./run-doorbell";
import { RunLoop } from "./run-loop";
import { resolveAndVerifyClaudeCodeExecutable } from "./sdk/claude-code-executable";
import { createSdkRunProcessor } from "./sdk/run-processor";
import { createStartRunQuery } from "./sdk/start-run-query";
import { Worker } from "./worker";
import { generateWorkerId } from "./worker-id";

// Entrypoint: the only place that reads the environment. Boots the worker —
// validated config, structured logger, worker id, a health endpoint, the
// Postgres-backed Claim/renew/terminalize loop, the real Claude Agent SDK
// processor over E2B, and graceful shutdown.
const config = loadWorkerConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const workerId = generateWorkerId();
const liveStreamTelemetry = createLiveStreamTelemetry("agent-worker", logger);
const liveStreamRelay = createRedisLiveStreamRelay({
	url: config.redisUrl,
	deployment: "current",
	telemetry: liveStreamTelemetry,
});
// Verify the native CLI before constructing a run loop: a missing or wrong-libc
// binary must crash boot before this process can claim work.
const pathToClaudeCodeExecutable = resolveAndVerifyClaudeCodeExecutable();

const worker = new Worker({
	workerId,
	maxConcurrentConversations: config.maxConcurrentConversations,
	shutdownTimeoutMs: config.shutdownTimeoutMs,
	logger,
});
const db = createDatabase(config.agentDatabaseUrl);
const artifactPublisher = createArtifactPublisher({
	db,
	objectStore: createS3ArtifactObjectStore(config.artifact),
});
const sandboxJanitor = createE2bSandboxJanitor(config.e2bApiKey);
const artifactObjectJanitor = createS3ArtifactObjectJanitor(config.artifact);
const startRunQuery = createStartRunQuery({
	db,
	provisioner: createE2bSandboxProvisioner({
		apiKey: config.e2bApiKey,
		template: config.e2bTemplate,
		sandboxIdleMs: config.sandboxIdleMs,
		logger,
	}),
	janitor: sandboxJanitor,
	documentClient: createDocumentSearch(
		{
			kbDatabaseUrl: config.kbDatabaseUrl,
			agentDatabaseUrl: config.agentDatabaseUrl,
		},
		logger,
	),
	modelClient: buildModelClientConfig(config.openrouter),
	pathToClaudeCodeExecutable,
	createClaudeConfigDir: async () => {
		const path = await mkdtemp(join(tmpdir(), "mymemo-agent-claude-config-"));
		return {
			path,
			dispose: async () => {
				await rm(path, { recursive: true, force: true });
			},
		};
	},
	processEnv: Bun.env,
	sandboxIdleMs: config.sandboxIdleMs,
	fileLimits: config.fileLimits,
	bashLimits: config.bashLimits,
	documentSearchMaxResults: config.maxDocumentSearchResults,
	documentListMaxResults: config.maxDocumentListResults,
	documentLoad: config.documentLoad,
	artifactPublisher,
	ensureWorkingDirectory: async (path) => {
		await mkdir(path, { recursive: true });
	},
	query,
	logger,
});
const runLoop = new RunLoop({
	db,
	worker,
	processor: createSdkRunProcessor({
		startRunQuery,
		logger,
	}),
	liveStreamRelay,
	liveStreamTelemetry,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
	// Admission commits and `running` → `interrupt_requested` transitions ring
	// this doorbell (the migration-0012 `run_doorbell` triggers), so pickup and
	// stop latency are milliseconds instead of a poll interval; the timer tick
	// above remains the source of truth if the LISTEN connection drops.
	doorbell: new PostgresRunDoorbell(config.agentDatabaseUrl, logger),
	logger,
});
// Worker-embedded external-resource cleanup (Task 8.1, ADR-0007/ADR-0011).
// Single-flighted across replicas by a Postgres advisory lock taken on a
// dedicated connection from Drizzle's underlying pg pool (`db.$client`). The
// The pass expires bounded Canary audit and reconciles E2B sandboxes and S3
// artifact objects from Postgres ledgers; it never lists either provider.
const cleanupLoop = new CleanupLoop({
	db,
	pool: db.$client as unknown as AdvisoryLockPool,
	sandboxJanitor,
	artifactJanitor: artifactObjectJanitor,
	workerId,
	intervalMs: config.cleanup.intervalMs,
	logger,
});
const server = startHealthServer(worker, config.port, logger);

runLoop.start();
cleanupLoop.start();

logger.info({
	message: "agent-worker started",
	workerId,
	maxConcurrentConversations: config.maxConcurrentConversations,
	heartbeatIntervalMs: config.heartbeatIntervalMs,
});

let shuttingDown = false;
async function handleShutdownSignal(signal: NodeJS.Signals): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info({ message: "Received shutdown signal", signal, workerId });
	cleanupLoop.stop();
	await runLoop.stop();
	await liveStreamRelay.close().catch(() => {});
	server.stop();
	logger.info({ message: "agent-worker stopped", workerId });
	process.exit(0);
}

process.on("SIGINT", (s) => void handleShutdownSignal(s));
process.on("SIGTERM", (s) => void handleShutdownSignal(s));
