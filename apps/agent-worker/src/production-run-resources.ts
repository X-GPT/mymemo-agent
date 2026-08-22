import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
	type LiveStreamService,
} from "@mymemo/live-text";
import {
	type ArtifactObjectStore,
	createArtifactPublisher,
} from "./artifacts/artifact-publication";
import { createS3ArtifactObjectStore } from "./artifacts/s3-artifact-object-store";
import { createE2bSandboxJanitor } from "./cleanup/e2b-janitor";
import type { WorkerConfig } from "./config/env";
import { createDocumentSearch } from "./documents/client";
import { createE2bSandboxProvisioner } from "./e2b/sandbox-provisioner";
import type { WorkerLogger } from "./logger";
import { buildModelClientConfig } from "./model-client";
import { resolveAndVerifyClaudeCodeExecutable } from "./sdk/claude-code-executable";
import { createSdkRunProcessor } from "./sdk/run-processor";
import { createStartRunQuery } from "./sdk/start-run-query";

export function createProductionRunResources(options: {
	config: WorkerConfig;
	logger: WorkerLogger;
	processEnv?: Record<string, string | undefined>;
	telemetryService?: LiveStreamService;
	artifactObjectKeyPrefix?: string;
	artifactObjectStore?: ArtifactObjectStore;
}) {
	const { config, logger } = options;
	const liveStreamTelemetry = createLiveStreamTelemetry(
		options.telemetryService ?? "agentcore-runtime",
		logger,
	);
	const liveStreamRelay = createRedisLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
		telemetry: liveStreamTelemetry,
	});
	// A missing or wrong-libc SDK binary must crash before either runtime can
	// obtain Conversation Ownership.
	const pathToClaudeCodeExecutable = resolveAndVerifyClaudeCodeExecutable();
	const db = createDatabase(config.agentDatabaseUrl);
	const artifactPublisher = createArtifactPublisher({
		db,
		objectStore:
			options.artifactObjectStore ??
			createS3ArtifactObjectStore(config.artifact),
		objectKeyPrefix: options.artifactObjectKeyPrefix,
	});
	const sandboxJanitor = createE2bSandboxJanitor(config.e2bApiKey);
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
		processEnv: options.processEnv ?? Bun.env,
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

	return {
		db,
		processor: createSdkRunProcessor({ startRunQuery, logger }),
		liveStreamRelay,
		liveStreamTelemetry,
		sandboxJanitor,
	};
}
