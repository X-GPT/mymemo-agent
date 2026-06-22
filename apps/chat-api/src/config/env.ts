import { join } from "node:path";
import invariant from "tiny-invariant";

export type ChatMessagesScope = "general" | "collection" | "document";

export type SandboxProviderKind = "e2b" | "local";

/** Subset of the process environment the API reads. */
type Env = Record<string, string | undefined>;

/**
 * Typed, validated configuration for the chat-api. Built once from the
 * environment at the entrypoint (`createApp`) and injected down via `AppDeps`,
 * so no other module reads global env. This mirrors the gateway's
 * `loadConfigFromEnv` seam and keeps the app decoupled from mutable global
 * process state — tests construct config explicitly instead of racing a cached
 * module singleton.
 */
export interface ApiConfig {
	/** `e2b` (default) leases a fresh sandbox per turn; `local` targets the harness daemon container. */
	sandboxProvider: SandboxProviderKind;
	/** Base URL of the local daemon container (SANDBOX_PROVIDER=local only). */
	localSandboxDaemonUrl: string;
	/** E2B template name (SANDBOX_PROVIDER=e2b only). */
	e2bTemplate: string;
	/** HMAC secret for the per-turn tokens minted into each sandbox turn (shared with the gateway). */
	llmTokenSecret: string;
	/** Base URL of the merged gateway, reachable from the sandbox; trailing slash stripped. */
	gatewayPublicUrl: string;
	/** pino log level. */
	logLevel: string;
	/** Root dir of the durable workspace store (local filesystem adapter). */
	workspaceStoreRoot: string;
	/**
	 * Writable connection to chat-api's own Postgres (`mymemo_agent`), distinct
	 * from the gateway's read-only KB. Backs the sandbox-lease registry.
	 * Optional: only consumed once leasing is wired into the turn path (Task 14),
	 * so a deployment without it keeps the per-turn create/kill behavior.
	 * DB_PASSWORD spliced in when passwordless; TLS applied (DB_SSL=disable to
	 * turn off for a local non-TLS Postgres).
	 */
	databaseUrl?: string;
}

/**
 * If DATABASE_URL is passwordless (the form the platform injects) and
 * DB_PASSWORD is set, splice the password in. Mirrors the gateway's helper.
 */
function withPassword(url: string, password: string | undefined): string {
	if (!password) return url;
	const m = /^([a-z]+:\/\/)([^@/]+)@(.*)$/i.exec(url);
	if (!m) return url;
	const [, scheme, userinfo, rest] = m;
	if (!scheme || !userinfo || rest === undefined) return url;
	if (userinfo.includes(":")) return url; // already has a password
	return `${scheme}${userinfo}:${encodeURIComponent(password)}@${rest}`;
}

/** Append `sslmode=require` unless TLS is disabled or the URL already sets it. */
function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=require`;
}

/**
 * Parse + validate the environment into a typed config. Pure: env in, config
 * out. `E2B_API_KEY` is validated here but not surfaced — the E2B SDK reads it
 * straight from `process.env` at `Sandbox.create`.
 */
export function loadApiConfigFromEnv(env: Env): ApiConfig {
	// Which sandbox provider runs the turn. Reject an unrecognized value loudly
	// rather than silently falling back to e2b (a typo like `locl` would
	// otherwise surface as a confusing "E2B_API_KEY required").
	const rawSandboxProvider = env.SANDBOX_PROVIDER;
	invariant(
		rawSandboxProvider === undefined ||
			rawSandboxProvider === "e2b" ||
			rawSandboxProvider === "local",
		`SANDBOX_PROVIDER must be "e2b" or "local" (got: ${rawSandboxProvider})`,
	);
	const sandboxProvider: SandboxProviderKind =
		rawSandboxProvider === "local" ? "local" : "e2b";

	// E2B credentials are only needed for the E2B provider; the local provider
	// reaches a container it does not create, so don't hard-require them there.
	if (sandboxProvider === "e2b") {
		invariant(
			env.E2B_API_KEY,
			"E2B_API_KEY is required when SANDBOX_PROVIDER=e2b",
		);
	}
	invariant(env.LLM_TOKEN_SECRET, "LLM_TOKEN_SECRET is required");
	invariant(env.GATEWAY_PUBLIC_URL, "GATEWAY_PUBLIC_URL is required");

	// Durable workspace store root. Optional with a writable fallback so it works
	// out of the box, but the fallback is process-local and lost on container
	// recycle — warn loudly so a missing volume mount in production surfaces here
	// instead of as silent data loss.
	const workspaceStoreRoot =
		env.WORKSPACE_STORE_ROOT || join(process.cwd(), ".workspace-store");
	if (!env.WORKSPACE_STORE_ROOT) {
		console.warn(
			`WORKSPACE_STORE_ROOT is not set; durable workspace state will be written to ${workspaceStoreRoot} and will NOT survive container recycles. Set it to a mounted persistent volume in production.`,
		);
	}

	return {
		sandboxProvider,
		// Same docker-compose network as chat-api; trailing slash stripped.
		localSandboxDaemonUrl: (
			env.LOCAL_SANDBOX_DAEMON_URL || "http://sandbox:8080"
		).replace(/\/+$/, ""),
		e2bTemplate: env.E2B_TEMPLATE || "sandbox-template-dev",
		llmTokenSecret: env.LLM_TOKEN_SECRET,
		// Trailing slash stripped so the binary's `${base}/v1/messages` never
		// produces a double slash.
		gatewayPublicUrl: env.GATEWAY_PUBLIC_URL.replace(/\/+$/, ""),
		logLevel: env.LOG_LEVEL || "info",
		workspaceStoreRoot,
		databaseUrl: env.DATABASE_URL
			? withSsl(
					withPassword(env.DATABASE_URL, env.DB_PASSWORD),
					env.DB_SSL !== "disable",
				)
			: undefined,
	};
}
