import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
} from "@mymemo/live-text";
import { Sandbox } from "e2b";
import {
	type ArtifactObjectStore,
	createArtifactPublisher,
} from "./artifacts/artifact-publication";
import { createS3ArtifactObjectStore } from "./artifacts/s3-artifact-object-store";
import { DEFAULT_BASH_TOOL_LIMITS } from "./bash-tool/bash-tool";
import { createDocumentSearch } from "./documents/client";
import { createE2bSandboxProvisioner } from "./e2b/sandbox-provisioner";
import { DEFAULT_FILE_TOOL_LIMITS } from "./file-tools/file-tools";
import type { RuntimeLogger } from "./logger";
import { buildModelClientConfig } from "./model-client";
import type { RuntimeConfig } from "./runtime-config";
import { resolveAndVerifyClaudeCodeExecutable } from "./sdk/claude-code-executable";
import { createSdkRunProcessor } from "./sdk/run-processor";
import { createStartRunQuery } from "./sdk/start-run-query";

const SANDBOX_IDLE_MS = 300_000;
const DOCUMENT_SEARCH_MAX_RESULTS = 8;
const DOCUMENT_LIST_MAX_RESULTS = 20;
const DOCUMENT_LOAD_LIMITS = {
	maxDocuments: 10,
	perDocumentMaxBytes: 262_144,
	perCallMaxBytes: 1_048_576,
};

export function createProductionRunResources(options: {
	config: RuntimeConfig;
	logger: RuntimeLogger;
	processEnv?: Record<string, string | undefined>;
	artifactObjectStore?: ArtifactObjectStore;
}) {
	const { config, logger } = options;
	const liveStreamTelemetry = createLiveStreamTelemetry(
		"agentcore-runtime",
		logger,
	);
	const liveStreamRelay = createRedisLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
		telemetry: liveStreamTelemetry,
	});
	// A missing or wrong-libc SDK binary must crash before the Runtime can
	// obtain Conversation Ownership.
	const pathToClaudeCodeExecutable = resolveAndVerifyClaudeCodeExecutable();
	const db = createDatabase(config.agentDatabaseUrl);
	const artifactPublisher = createArtifactPublisher({
		db,
		objectStore:
			options.artifactObjectStore ??
			createS3ArtifactObjectStore(config.artifact),
	});
	const startRunQuery = createStartRunQuery({
		db,
		provisioner: createE2bSandboxProvisioner({
			apiKey: config.e2bApiKey,
			template: config.e2bTemplate,
			sandboxIdleMs: SANDBOX_IDLE_MS,
			logger,
		}),
		janitor: {
			async killSandbox(sandboxId) {
				await Sandbox.kill(sandboxId, { apiKey: config.e2bApiKey });
			},
		},
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
		fileLimits: DEFAULT_FILE_TOOL_LIMITS,
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
	};
}
