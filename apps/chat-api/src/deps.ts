import { createDatabase } from "@mymemo/agent-db/client";
import {
	type DocumentAccessLog,
	PostgresDocumentAccessLog,
} from "@mymemo/document-tools/access-log";
import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
	createRedisTurnLiveStreamRelay,
	type LiveStreamRelay,
	type LiveStreamTelemetry,
	type TurnLiveStreamRelay,
} from "@mymemo/live-text";
import type { Env as PinoEnv } from "hono-pino";
import type { ApiConfig } from "./config/env";
import type { HarnessChatAgentFactory } from "./features/ai-chat/harness-chat-agent";
import {
	type HarnessResumeStateStore,
	PostgresHarnessResumeStateStore,
} from "./features/ai-chat/harness-resume-state-store";
import type { ArtifactDownloadSigner } from "./features/artifacts/artifact-download-signer";
import type { ArtifactMetadataStore } from "./features/artifacts/artifact-metadata-store";
import { PostgresArtifactMetadataStore } from "./features/artifacts/postgres-artifact-metadata-store";
import { createS3ArtifactDownloadSigner } from "./features/artifacts/s3-artifact-download-signer";
import type { ConversationHistoryStore } from "./features/conversation-history/conversation-history-store";
import { PostgresConversationHistoryStore } from "./features/conversation-history/postgres-conversation-history-store";
import type {
	ConversationMessagesStore,
	TurnSubmissionStore,
} from "./features/conversation-messages/conversation-messages-store";
import { PostgresConversationMessagesStore } from "./features/conversation-messages/postgres-conversation-messages-store";
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
	/** Builds the `HarnessAgent` for one Harness turn (local composition only). */
	createHarnessChatAgent: HarnessChatAgentFactory;
	/** Per-Conversation opaque Harness resume pointer (local composition only). */
	harnessResumeStateStore: HarnessResumeStateStore;
	/** `document_access_events` rows for the Harness document tools (local composition only). */
	documentAccessLog: DocumentAccessLog;
	/** Authoritative current Downloadable artifact metadata in Postgres. */
	artifactMetadataStore: ArtifactMetadataStore;
	/** Creates short-lived direct-download URLs after ownership authorization. */
	artifactDownloadSigner: ArtifactDownloadSigner;
	/** Durable conversation registry (source of truth for frozen scope). */
	conversationStore: ConversationStore;
	/** Permanent AG-UI Conversation-history projection over Postgres Runs. */
	conversationHistoryStore: ConversationHistoryStore;
	/** /v2 UIMessage history over `conversation_messages` plus the `queued` Turn INSERT — chat-api's only write; the In-VM server owns every status transition. */
	conversationMessagesStore: ConversationMessagesStore & TurnSubmissionStore;
	/** Durable split-runtime run queue and event log. */
	runStore: RunStore;
	/** Producer-buffered per-Run relay used by initial and reconnect SSE. */
	liveStreamRelay: LiveStreamRelay;
	/** The v2 per-Turn UIMessage lane (#658) the message POST subscribes to. */
	turnLiveStreamRelay: TurnLiveStreamRelay;
	/**
	 * Ensure-VM + nudge for one Conversation (#667). Undefined = not configured,
	 * so the v2 message POST answers 503. Today a dev-mode stub over
	 * `IN_VM_SERVER_URL`; the orchestration ticket replaces it.
	 */
	nudgeInVmServer?: () => Promise<void>;
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
	/**
	 * Upstream HTTP client for the /v2 model gateway. Injectable so route tests
	 * exercise token validation, credential injection, and streaming without a
	 * network or a real OpenRouter key.
	 */
	gatewayUpstreamFetch: typeof fetch;
}

/** Hono environment: pino logger vars plus request-scoped dependencies and identity. */
export type AppEnv = PinoEnv & {
	Variables: { deps: AppDeps; identity: InternalIdentity };
};

export function createDeps(
	config: ApiConfig,
	createHarnessChatAgent: HarnessChatAgentFactory,
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
			region: config.artifactRegion,
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
	const liveStreamRelay = createRedisLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
		telemetry: liveStreamTelemetry,
	});
	const turnLiveStreamRelay = createRedisTurnLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
	});
	return {
		config,
		createHarnessChatAgent,
		harnessResumeStateStore: new PostgresHarnessResumeStateStore(database),
		documentAccessLog: new PostgresDocumentAccessLog(database),
		artifactMetadataStore: new PostgresArtifactMetadataStore(database),
		artifactDownloadSigner,
		conversationStore,
		conversationHistoryStore,
		conversationMessagesStore: new PostgresConversationMessagesStore(database),
		runStore,
		liveStreamRelay,
		turnLiveStreamRelay,
		// ponytail: one config-provided In-VM server, nudged by URL; the
		// orchestration ticket swaps in per-Conversation MicroVM launch here.
		nudgeInVmServer: config.inVmServerUrl
			? async () => {
					const response = await fetch(`${config.inVmServerUrl}/nudge`, {
						method: "POST",
					});
					if (!response.ok) {
						throw new Error(`nudge answered ${response.status}`);
					}
				}
			: undefined,
		liveStreamTelemetry,
		closeLiveResources: async () => {
			await Promise.all([liveStreamRelay.close(), turnLiveStreamRelay.close()]);
		},
		exposureGate,
		gatewayUpstreamFetch: fetch,
	};
}
