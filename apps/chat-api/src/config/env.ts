import { join } from "node:path";
import invariant from "tiny-invariant";

/**
 * Environment variables for the API server
 * All variables are validated at module load time
 */
export const apiEnv = (() => {
	invariant(Bun.env.E2B_API_KEY, "E2B_API_KEY is required");
	invariant(Bun.env.DAEMON_AUTH_TOKEN, "DAEMON_AUTH_TOKEN is required");
	invariant(Bun.env.LLM_TOKEN_SECRET, "LLM_TOKEN_SECRET is required");
	invariant(Bun.env.GATEWAY_PUBLIC_URL, "GATEWAY_PUBLIC_URL is required");

	// Durable workspace store root. Optional with a writable fallback so it works
	// out of the box, but the fallback is process-local and lost on container
	// recycle — warn loudly so a missing volume mount in production surfaces here
	// instead of as silent data loss.
	const workspaceStoreRoot =
		Bun.env.WORKSPACE_STORE_ROOT || join(process.cwd(), ".workspace-store");
	if (!Bun.env.WORKSPACE_STORE_ROOT) {
		console.warn(
			`WORKSPACE_STORE_ROOT is not set; durable workspace state will be written to ${workspaceStoreRoot} and will NOT survive container recycles. Set it to a mounted persistent volume in production.`,
		);
	}

	return {
		DAEMON_AUTH_TOKEN: Bun.env.DAEMON_AUTH_TOKEN,
		// HMAC secret for the session tokens minted into each sandbox turn. Shared
		// with the gateway, which verifies them and enforces the token's signed
		// document scope.
		LLM_TOKEN_SECRET: Bun.env.LLM_TOKEN_SECRET,
		// Base URL of the merged gateway. The sandboxed agent points BOTH the Claude
		// binary (ANTHROPIC_BASE_URL → /v1/messages) and the `mymemo-docs` CLI
		// (MYMEMO_DOC_GATEWAY_URL → /v1/documents/*) at this one service. Must be
		// reachable from inside the E2B sandbox. Trailing slash stripped so the
		// binary's `${base}/v1/messages` never produces a double slash.
		GATEWAY_PUBLIC_URL: Bun.env.GATEWAY_PUBLIC_URL.replace(/\/+$/, ""),
		LOG_LEVEL: Bun.env.LOG_LEVEL || "info",
		E2B_TEMPLATE: Bun.env.E2B_TEMPLATE || "sandbox-template-dev",
		// Root directory of the durable workspace store (local filesystem adapter).
		// Defaults to a writable dir under the process cwd so it works out of the
		// box (in the container the cwd is the app dir, which is writable by the
		// `bun` user); in production point this at a mounted persistent volume so
		// durable conversation and run state survives container recycles.
		WORKSPACE_STORE_ROOT: workspaceStoreRoot,
	} as const;
})();

export type ChatMessagesScope = "general" | "collection" | "document";
