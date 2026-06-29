import { hostname } from "node:os";
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
import { createLeaseStore } from "./features/lease-store";
import { E2BSandboxProvider } from "./features/sandbox-orchestration/e2b-sandbox-provider";
import { LocalContainerSandboxProvider } from "./features/sandbox-orchestration/local-container-sandbox-provider";
import { SandboxLeaseManager } from "./features/sandbox-orchestration/sandbox-lease-manager";
import type { SandboxProvider } from "./features/sandbox-orchestration/sandbox-provider";
import {
	createLocalWorkspaceStore,
	type WorkspaceStore,
} from "./features/workspace-store";

/**
 * Application dependencies, built once from a validated `ApiConfig` at the
 * composition root (`createApp`) and injected down the request path instead of
 * being read from module-global singletons. This keeps env reads at the edge
 * and makes the chat path testable by constructing `AppDeps` directly.
 */
export interface AppDeps {
	config: ApiConfig;
	sandboxProvider: SandboxProvider;
	workspaceStore: WorkspaceStore;
	/** Durable conversation registry (source of truth for frozen scope). */
	conversationStore: ConversationStore;
	/**
	 * Warm-sandbox leasing for the turn path. Every turn leases its sandbox
	 * through this (reused across a conversation's turns, created on a miss).
	 */
	leaseManager: SandboxLeaseManager;
	/**
	 * Server-side gate controlling who may create new agent work. Consulted on
	 * the new-work paths (conversation create, `user.message`) after identity is
	 * parsed and before any write. Fails closed.
	 */
	exposureGate: ExposureGate;
}

/** Hono environment: pino logger vars plus the injected `AppDeps`. */
export type AppEnv = PinoEnv & { Variables: { deps: AppDeps } };

export function createDeps(config: ApiConfig): AppDeps {
	const sandboxProvider: SandboxProvider =
		config.sandboxProvider === "local"
			? new LocalContainerSandboxProvider(config)
			: new E2BSandboxProvider(config);
	const workspaceStore = createLocalWorkspaceStore(config.workspaceStoreRoot);
	// One Drizzle pool over the writable DB, shared by every store (the lease
	// store reuses it) rather than a pool per store.
	const database = createDatabase(config.databaseUrl);
	const conversationStore = new PostgresConversationStore(database);
	// Per-process identity for the ownership lease: stable for this process's
	// lifetime, unique across replicas (and across a restart), so a crashed
	// process's leases expire rather than being mistaken for a live owner's.
	const ownerId = `${hostname()}:${process.pid}:${crypto.randomUUID()}`;
	const leaseManager = new SandboxLeaseManager(
		{ sandboxProvider, leaseStore: createLeaseStore(database), workspaceStore },
		ownerId,
	);
	return {
		config,
		sandboxProvider,
		workspaceStore,
		conversationStore,
		leaseManager,
		exposureGate: createExposureGate(config),
	};
}
