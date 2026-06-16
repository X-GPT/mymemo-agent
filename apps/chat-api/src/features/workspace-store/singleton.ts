import { apiEnv } from "@/config/env";
import { createLocalWorkspaceStore } from "./local-workspace-store";

/**
 * Process-wide durable workspace store. A local filesystem adapter rooted at
 * `WORKSPACE_STORE_ROOT` until an object-storage provider is finalized.
 */
export const workspaceStore = createLocalWorkspaceStore(
	apiEnv.WORKSPACE_STORE_ROOT,
);
