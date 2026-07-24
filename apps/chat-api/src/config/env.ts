import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";

export type ChatMessagesScope = "general" | "collection" | "document";

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
	/** pino log level. */
	logLevel: string;
	/** Private S3 bucket holding durable Downloadable artifact objects. */
	artifactBucket: string;
	/** AWS region containing the private Downloadable artifact bucket. */
	artifactRegion: string;
	/**
	 * Writable connection to chat-api's own Postgres (`mymemo_agent`), distinct
	 * from the gateway's/worker's read-only KB. Backs the conversation registry
	 * (frozen scope), run queue, and run event log. Sourced from
	 * `AGENT_DATABASE_URL` — never the generic `DATABASE_URL`, which names the
	 * read-only KB elsewhere in the repo. **Required** — the conversation
	 * endpoints are the primary surface and cannot work without it, so it is
	 * validated at config load rather than failing per-request. DB_PASSWORD
	 * spliced in when passwordless; TLS applied (DB_SSL=disable to turn off for a
	 * local non-TLS Postgres).
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
	/** Required authenticated TLS Redis secret for the Live Stream relay. */
	redisUrl: string;
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

/**
 * Append `sslmode=no-verify` unless TLS is disabled or the URL already sets it.
 * We want the connection encrypted but not CA-verified: RDS presents the Amazon
 * RDS CA, which is not in Node's default trust store. node-postgres's
 * pg-connection-string aliases `sslmode=require` to `verify-full` (strict
 * CA-chain verification), so `require` fails with SELF_SIGNED_CERT_IN_CHAIN;
 * `no-verify` maps to `rejectUnauthorized: false`. Do not change back to
 * `require` without also shipping the RDS CA bundle (e.g. NODE_EXTRA_CA_CERTS).
 */
function withSsl(url: string, enabled: boolean): string {
	if (!enabled || /[?&]sslmode=/.test(url)) return url;
	return `${url}${url.includes("?") ? "&" : "?"}sslmode=no-verify`;
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
 * out. Worker-only secrets (OpenRouter, KB, E2B, model credentials) are
 * intentionally not read here.
 */
export function loadApiConfigFromEnv(env: Env): ApiConfig {
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

	const artifactBucket = env.ARTIFACT_BUCKET?.trim();
	assert(artifactBucket, "ARTIFACT_BUCKET is required");
	const artifactRegion = env.AWS_REGION?.trim();
	assert(artifactRegion, "AWS_REGION is required");

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

	return {
		logLevel: env.LOG_LEVEL || "info",
		databaseUrl,
		artifactBucket,
		artifactRegion,
		statsigServerSecret: env.STATSIG_SERVER_SECRET,
		agentExposureBreakGlass,
		redisUrl: resolveLiveStreamRedisUrl(env.REDIS_URL, {
			allowInsecureLoopback:
				env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS === "true",
		}),
	};
}
