import { join } from "node:path";

export type ChatMessagesScope = "general" | "collection" | "document";

export type SandboxProviderKind = "e2b" | "local";

/** Subset of the process environment the API reads. */
type Env = Record<string, string | undefined>;

/**
 * Assert a config invariant, throwing an Error whose message survives
 * production builds. Deliberately NOT tiny-invariant: that strips the message
 * when NODE_ENV=production, which would turn a misconfigured prod boot into an
 * opaque "Invariant failed" instead of naming the missing variable.
 */
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

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
	 * from the gateway's/worker's read-only KB. Backs the conversation registry
	 * (frozen scope), the sandbox-lease registry, and (in the split runtime) the
	 * run queue and event log. Sourced from `AGENT_DATABASE_URL` — never the
	 * generic `DATABASE_URL`, which names the read-only KB elsewhere in the repo.
	 * **Required** — the conversation endpoints are the primary surface and cannot
	 * work without it, so it is validated at config load rather than failing
	 * per-request. DB_PASSWORD spliced in when passwordless; TLS applied
	 * (DB_SSL=disable to turn off for a local non-TLS Postgres).
	 */
	databaseUrl: string;
	/**
	 * Statsig server secret backing the production agent exposure gate (MYM-46).
	 * Required unless operator break-glass is on; undefined only in that case.
	 * Never sent to the sandbox or logged.
	 */
	statsigServerSecret: string | undefined;
	/**
	 * Operator break-glass for the agent exposure gate. When true, new agent work
	 * is allowed without Statsig (local dev, or an incident where Statsig is
	 * unavailable). When false (production default), the gate fails closed and a
	 * Statsig secret is required. Identity-independent and explicit.
	 */
	agentExposureBreakGlass: boolean;
}

/**
 * If the DB URL is passwordless (the form the platform injects) and DB_PASSWORD
 * is set, splice the password in. Mirrors the gateway's helper.
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
 * Resolve the writable DB connection string from its env parts: splice in
 * DB_PASSWORD when passwordless, and apply TLS unless DB_SSL=disable. Shared by
 * the app config and the standalone migration runner so both connect identically.
 */
export function resolveDatabaseUrl(
	databaseUrl: string | undefined,
	dbPassword: string | undefined,
	dbSsl: string | undefined,
): string | undefined {
	if (!databaseUrl) return undefined;
	return withSsl(withPassword(databaseUrl, dbPassword), dbSsl !== "disable");
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
	assert(
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
		assert(
			env.E2B_API_KEY,
			"E2B_API_KEY is required when SANDBOX_PROVIDER=e2b",
		);
	}
	assert(env.LLM_TOKEN_SECRET, "LLM_TOKEN_SECRET is required");
	assert(env.GATEWAY_PUBLIC_URL, "GATEWAY_PUBLIC_URL is required");

	// The conversation registry is the primary surface and cannot work without a
	// writable DB; require it at load so a misconfigured deploy fails fast instead
	// of booting green and 503-ing every request. Sourced from AGENT_DATABASE_URL
	// (the writable mymemo_agent DB), never the generic DATABASE_URL — that name
	// is the read-only KB credential elsewhere in the repo, and conflating them
	// would point chat-api at the wrong trust domain.
	const databaseUrl = resolveDatabaseUrl(
		env.AGENT_DATABASE_URL,
		env.DB_PASSWORD,
		env.DB_SSL,
	);
	assert(databaseUrl, "AGENT_DATABASE_URL is required");

	// Agent exposure (MYM-46) fails closed in production: a Statsig secret is
	// required unless an operator explicitly enables break-glass (local dev, or an
	// incident where Statsig is unavailable). The worker-only secrets (OpenRouter,
	// KB) are intentionally NOT read here — chat-api must not hold them.
	const agentExposureBreakGlass = env.AGENT_EXPOSURE_BREAK_GLASS === "true";
	if (!agentExposureBreakGlass) {
		assert(
			env.STATSIG_SERVER_SECRET,
			"STATSIG_SERVER_SECRET is required (or set AGENT_EXPOSURE_BREAK_GLASS=true to open the gate without Statsig)",
		);
	}

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
		databaseUrl,
		statsigServerSecret: env.STATSIG_SERVER_SECRET,
		agentExposureBreakGlass,
	};
}
