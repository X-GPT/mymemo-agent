import {
	createLiveStreamTelemetry,
	createRedisLiveStreamRelay,
	type LiveStreamRelay,
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
import { createRuntimeGate, type RuntimeGate } from "./features/runtime-gate";

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
	/** Selects and freezes one execution runtime at Conversation creation. */
	runtimeGate: RuntimeGate;
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
	const liveStreamRelay = createRedisLiveStreamRelay({
		url: config.redisUrl,
		deployment: "current",
		telemetry: liveStreamTelemetry,
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
		liveStreamRelay,
		liveStreamTelemetry,
		closeLiveResources: () => liveStreamRelay.close(),
		exposureGate: createExposureGate(config),
		runtimeGate: createRuntimeGate(config),
	};
}
