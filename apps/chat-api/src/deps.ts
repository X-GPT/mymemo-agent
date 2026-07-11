import {
	createLiveTextTelemetry,
	createRedisLiveTextTransport,
	disabledLiveTextSubscriber,
	type LiveTextSubscriber,
	type LiveTextTelemetry,
	type LiveTextTransport,
	type RedisLiveTextSignal,
} from "@mymemo/live-text";
import type { Env as PinoEnv } from "hono-pino";
import type { ApiConfig } from "./config/env";
import { createDatabase } from "./db/client";
import {
	type ConversationStore,
	PostgresConversationStore,
} from "./features/conversation-store";
import {
	createExposureGate,
	type ExposureGate,
} from "./features/exposure-gate";
import {
	DrizzleRunEventReader,
	PostgresRunNotifier,
	type RunEventReader,
	type RunNotifier,
} from "./features/run-events";
import { reportChatLiveTextRuntimeSignal } from "./features/run-events/live-text-telemetry";
import { PostgresRunStore, type RunStore } from "./features/run-store";

/**
 * Application dependencies, built once from a validated `ApiConfig` at the
 * composition root (`createApp`) and injected down the request path instead of
 * being read from module-global singletons. This keeps env reads at the edge
 * and makes the chat path testable by constructing `AppDeps` directly.
 */
export interface AppDeps {
	config: ApiConfig;
	/** Durable conversation registry (source of truth for frozen scope). */
	conversationStore: ConversationStore;
	/** Durable split-runtime run queue and event log. */
	runStore: RunStore;
	/** Durable run-event replay source for SSE projection. */
	runEventReader: RunEventReader;
	/** Run-event wake-up source for live SSE projection. */
	runNotifier: RunNotifier;
	/** Optional ephemeral Assistant-text preview lane. */
	liveTextSubscriber: LiveTextSubscriber;
	/** Cardinality-safe, payload-free Live-lane observability. */
	liveTextTelemetry: LiveTextTelemetry;
	/** Close optional Live transport resources during service shutdown. */
	closeLiveText?: () => Promise<void>;
	/**
	 * Server-side gate controlling who may create new agent work. Consulted on
	 * the new-work paths (conversation create, `user.message`) after identity is
	 * parsed and before any write. Fails closed.
	 */
	exposureGate: ExposureGate;
}

/** Hono environment: pino logger vars plus the injected `AppDeps`. */
export type AppEnv = PinoEnv & { Variables: { deps: AppDeps } };

export type LiveTextRuntimeSignal = RedisLiveTextSignal | "disabled";

export function createDeps(
	config: ApiConfig,
	liveTextTelemetry: LiveTextTelemetry = createLiveTextTelemetry("chat-api", {
		info() {},
		warn() {},
	}),
): AppDeps {
	// One Drizzle pool over the writable DB, shared by every store.
	const database = createDatabase(config.databaseUrl);
	const conversationStore = new PostgresConversationStore(database);
	const runStore = new PostgresRunStore(database);
	const runEventReader = new DrizzleRunEventReader(database);
	const runNotifier = new PostgresRunNotifier(config.databaseUrl);
	const emitLiveTextSignal = (signal: LiveTextRuntimeSignal) => {
		reportChatLiveTextRuntimeSignal(liveTextTelemetry, signal);
	};
	const liveTextTransport: LiveTextTransport | undefined =
		config.liveTextRedisUrl === undefined
			? undefined
			: createRedisLiveTextTransport({
					url: config.liveTextRedisUrl,
					onSignal: emitLiveTextSignal,
				});
	if (!liveTextTransport) emitLiveTextSignal("disabled");
	return {
		config,
		conversationStore,
		runStore,
		runEventReader,
		runNotifier,
		liveTextSubscriber: liveTextTransport ?? disabledLiveTextSubscriber,
		liveTextTelemetry,
		closeLiveText: liveTextTransport
			? () => liveTextTransport.close()
			: undefined,
		exposureGate: createExposureGate(config),
	};
}
