import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";

export { resolveDatabaseUrl };

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
	 * Statsig server secret backing the production exposure and runtime gates.
	 * Required unless operator break-glass is on; undefined only in that case.
	 * Never sent to the sandbox or logged.
	 */
	statsigServerSecret: string | undefined;
	/**
	 * Operator break-glass for Statsig gating. When true, new agent work is allowed
	 * without Statsig and every new Conversation selects Fargate (local dev, or an
	 * incident where Statsig is unavailable). When false (production default), the
	 * exposure gate fails closed and a Statsig secret is required.
	 */
	agentExposureBreakGlass: boolean;
	/** Required authenticated TLS Redis secret for the Live Stream relay. */
	redisUrl: string;
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

	// Statsig exposure fails closed and runtime selection fails safe to Fargate: a
	// Statsig secret is required unless an operator explicitly enables break-glass
	// (local dev, or an incident where Statsig is unavailable). Worker-only secrets (OpenRouter,
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
