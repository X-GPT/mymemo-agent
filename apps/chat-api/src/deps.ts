import type { Env as PinoEnv } from "hono-pino";
import type { ApiConfig } from "./config/env";
import {
	type ConversationStore,
	createConversationStore,
} from "./features/conversation-store";
import { E2BSandboxProvider } from "./features/sandbox-orchestration/e2b-sandbox-provider";
import { LocalContainerSandboxProvider } from "./features/sandbox-orchestration/local-container-sandbox-provider";
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
	/**
	 * Durable conversation registry (source of truth for frozen scope). `null`
	 * when no `DATABASE_URL` is configured — the conversation endpoints require it
	 * and respond 503 when it is absent.
	 */
	conversationStore: ConversationStore | null;
}

/** Hono environment: pino logger vars plus the injected `AppDeps`. */
export type AppEnv = PinoEnv & { Variables: { deps: AppDeps } };

export function createDeps(config: ApiConfig): AppDeps {
	const sandboxProvider: SandboxProvider =
		config.sandboxProvider === "local"
			? new LocalContainerSandboxProvider(config)
			: new E2BSandboxProvider(config);
	const workspaceStore = createLocalWorkspaceStore(config.workspaceStoreRoot);
	const conversationStore = createConversationStore(config);
	return { config, sandboxProvider, workspaceStore, conversationStore };
}
