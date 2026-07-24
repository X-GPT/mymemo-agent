import {
	createLiveStreamTelemetry,
	createRedisLiveStreamStore,
	type LiveStreamReader,
	type LiveStreamTelemetry,
} from "@mymemo/live-text";
import type { Env as PinoEnv } from "hono-pino";
import type { ApiConfig } from "./config/env";
import { createDatabase } from "./db/client";
import type {
	ArtifactDownloadSigner,
	ArtifactMetadataStore,
} from "./features/artifacts";
import {
	createS3ArtifactDownloadSigner,
	PostgresArtifactMetadataStore,
} from "./features/artifacts";
import {
	type ConversationHistoryStore,
	PostgresConversationHistoryStore,
} from "./features/conversation-history";
import {
	type ConversationStore,
	PostgresConversationStore,
} from "./features/conversation-store";
import {
	createExposureGate,
	type ExposureGate,
} from "./features/exposure-gate";
import { PostgresRunStore, type RunStore } from "./features/run-store";

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
	/** Retained per-Run AG-UI event source used by initial and reconnect SSE. */
	liveStreamReader: LiveStreamReader;
	/** Cardinality-safe, payload-free retained Live Stream observability. */
	liveStreamTelemetry: LiveStreamTelemetry;
	/** Close the lazy Redis Stream client during service shutdown. */
	closeLiveResources: () => Promise<void>;
	/**
	 * Server-side gate controlling who may create new agent work. Consulted on
	 * the new-work paths (Conversation creation and Run admission) after identity is
	 * parsed and before any write. Fails closed.
	 */
	exposureGate: ExposureGate;
}

/** Hono environment: pino logger vars plus the injected `AppDeps`. */
export type AppEnv = PinoEnv & { Variables: { deps: AppDeps } };

export function createDeps(
	config: ApiConfig,
	liveStreamTelemetry: LiveStreamTelemetry = createLiveStreamTelemetry(
		"chat-api",
		{
			info() {},
			warn() {},
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
	const liveStreamStore = createRedisLiveStreamStore({
		url: config.redisUrl,
		deployment: "current",
	});
	return {
		config,
		artifactMetadataStore: new PostgresArtifactMetadataStore(database),
		artifactDownloadSigner: createS3ArtifactDownloadSigner({
			bucket: config.artifactBucket,
			region: config.artifactRegion,
		}),
		conversationStore,
		conversationHistoryStore,
		runStore,
		liveStreamReader: liveStreamStore satisfies LiveStreamReader,
		liveStreamTelemetry,
		closeLiveResources: () => liveStreamStore.close(),
		exposureGate: createExposureGate(config),
	};
}
