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
import { DEFAULT_BASH_TOOL_LIMITS } from "./bash-tool/bash-tool";
import { createDocumentSearch } from "./documents/client";
import { createE2bSandboxJanitor } from "./e2b/sandbox-janitor";
import { createE2bSandboxProvisioner } from "./e2b/sandbox-provisioner";
import type { FileToolLimits } from "./file-tools/file-tools";
import type { WorkerLogger } from "./logger";
import { buildModelClientConfig } from "./model-client";
import { resolveAndVerifyClaudeCodeExecutable } from "./sdk/claude-code-executable";
import { createSdkRunProcessor } from "./sdk/run-processor";
import { createStartRunQuery } from "./sdk/start-run-query";
import type { WorkerConfig } from "./worker-config";

const SANDBOX_IDLE_MS = 300_000;
const FILE_LIMITS: FileToolLimits = {
	readMaxBytes: 65_536,
	readMaxLines: 2_000,
	grepMaxResults: 100,
	commandMaxOutputBytes: 65_536,
	commandTimeoutMs: 30_000,
};
const DOCUMENT_SEARCH_MAX_RESULTS = 8;
const DOCUMENT_LIST_MAX_RESULTS = 20;
const DOCUMENT_LOAD_LIMITS = {
	maxDocuments: 10,
	perDocumentMaxBytes: 262_144,
	perCallMaxBytes: 1_048_576,
};

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
			sandboxIdleMs: SANDBOX_IDLE_MS,
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
		sandboxIdleMs: SANDBOX_IDLE_MS,
		fileLimits: FILE_LIMITS,
		bashLimits: DEFAULT_BASH_TOOL_LIMITS,
		documentSearchMaxResults: DOCUMENT_SEARCH_MAX_RESULTS,
		documentListMaxResults: DOCUMENT_LIST_MAX_RESULTS,
		documentLoad: DOCUMENT_LOAD_LIMITS,
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
