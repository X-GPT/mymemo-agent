import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { createDatabase } from "@mymemo/agent-db/client";
import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import type { Env as PinoEnv } from "hono-pino";
import type { ApiConfig } from "./config/env";
import { createBedrockAgentQueryRuntimeInvoker } from "./features/ai-chat/agent-query-runtime-invoker";
import { PostgresChatMessageStore } from "./features/ai-chat/postgres-chat-message-store";
import { createAiChatResumableStreams } from "./features/ai-chat/resumable-streams";
import type { ArtifactDownloadSigner } from "./features/artifacts/artifact-download-signer";
import type { ArtifactMetadataStore } from "./features/artifacts/artifact-metadata-store";
import { PostgresArtifactMetadataStore } from "./features/artifacts/postgres-artifact-metadata-store";
import { createS3ArtifactDownloadSigner } from "./features/artifacts/s3-artifact-download-signer";
import type { ConversationHistoryStore } from "./features/conversation-history/conversation-history-store";
import { PostgresConversationHistoryStore } from "./features/conversation-history/postgres-conversation-history-store";
import type { ConversationStore } from "./features/conversation-store/conversation-store";
import { PostgresConversationStore } from "./features/conversation-store/postgres-conversation-store";
import type { InternalIdentity } from "./features/conversations/conversations.schema";
import {
	createExposureGate,
	type ExposureGate,
} from "./features/exposure-gate";
import {
	PostgresRunStore,
	type RunStore,
} from "./features/run-store/run-store";

/**
 * Application dependencies, built once from a validated `ApiConfig` at the
 * composition root (`createApp`) and injected down the request path instead of
 * being read from module-global singletons. This keeps env reads at the edge
 * and makes the chat path testable by constructing `AppDeps` directly.
 */
export interface AppDeps {
	config: ApiConfig;
	/** Authoritative current Downloadable artifact metadata in Postgres. */
	artifactMetadataStore: ArtifactMetadataStore;
	/** Creates short-lived direct-download URLs after ownership authorization. */
	artifactDownloadSigner: ArtifactDownloadSigner;
	/** Durable conversation registry (source of truth for frozen scope). */
	conversationStore: ConversationStore;
	/** Permanent AG-UI Conversation-history projection over Postgres Runs. */
	conversationHistoryStore: ConversationHistoryStore;
	/** Durable split-runtime run queue and event log. */
	runStore: RunStore;
	/** Producer-buffered per-Run relay used by initial and reconnect SSE. */
	liveStreamRelay: LiveStreamRelay;
	/** Cardinality-safe, payload-free Live Stream relay observability. */
	liveStreamTelemetry: LiveStreamTelemetry;
	/** Close the lazy Redis relay clients during service shutdown. */
	closeLiveResources: () => Promise<void>;
	/**
	 * Server-side gate controlling who may create new agent work. Consulted on
	 * the new-work paths (Conversation creation and Run admission) after identity is
	 * parsed and before any write. Fails closed.
	 */
	exposureGate: ExposureGate;
	/** Direct-response persistence over the shared writable database. */
	chatMessageStore: PostgresChatMessageStore;
	/** Standard Redis-backed AI SDK response resumption. */
	resumableStreams: ReturnType<typeof createAiChatResumableStreams>;
	/** Direct-response Runtime invoker when its non-production Runtime is configured. */
	agentQueryRuntimeInvoker: ReturnType<
		typeof createBedrockAgentQueryRuntimeInvoker
	> | null;
}

/** Hono environment: pino logger vars plus request-scoped dependencies and identity. */
export type AppEnv = PinoEnv & {
	Variables: { deps: AppDeps; identity: InternalIdentity };
};

export function createDeps(
	config: ApiConfig,
	liveStreamTelemetry: LiveStreamTelemetry = createLiveStreamTelemetry(
		"chat-api",
		{
			info() {},
			warn() {},
		},
	),
	exposureGate: ExposureGate = createExposureGate(config),
	artifactDownloadSigner: ArtifactDownloadSigner = createS3ArtifactDownloadSigner(
		{
			bucket: config.artifactBucket,
			region: config.awsRegion,
		},
	),
): AppDeps {
	// One Drizzle pool over the writable DB, shared by every store.
	const database = createDatabase(config.databaseUrl);
	const conversationStore = new PostgresConversationStore(database);
	const conversationHistoryStore = new PostgresConversationHistoryStore(
		database,
	);
	const runStore = new PostgresRunStore(database);
	const chatMessageStore = new PostgresChatMessageStore(database);
	const resumableStreams = createAiChatResumableStreams(config.redisUrl);
	const liveStreamRelay = createRedisLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
		telemetry: liveStreamTelemetry,
	});
	return {
		config,
		artifactMetadataStore: new PostgresArtifactMetadataStore(database),
		artifactDownloadSigner,
		conversationStore,
		conversationHistoryStore,
		runStore,
		chatMessageStore,
		resumableStreams,
		agentQueryRuntimeInvoker: config.agentQueryRuntimeArn
			? createBedrockAgentQueryRuntimeInvoker({
					client: new BedrockAgentCoreClient({
						region: config.awsRegion,
					}),
					agentRuntimeArn: config.agentQueryRuntimeArn,
				})
			: null,
		liveStreamRelay,
		liveStreamTelemetry,
		closeLiveResources: async () => {
			resumableStreams.close();
			await liveStreamRelay.close();
		},
		exposureGate,
	};
}
