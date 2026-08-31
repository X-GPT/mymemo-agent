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
	 * Statsig server secret backing the production exposure gate.
	 * Never sent to the sandbox or logged.
	 */
	statsigServerSecret: string;
	/** Required authenticated TLS Redis secret for the Live Stream relay. */
	redisUrl: string;
	/**
	 * OpenRouter credential for the /v2 model gateway — ADR-0034's deliberate
	 * revision of the rule that kept provider credentials out of chat-api. Held
	 * in chat-api env only and injected on gateway-forwarded requests; never
	 * delivered to a VM, image, or Checkpoint. Optional until the Terraform
	 * secret wiring lands: while absent the gateway route answers 503 and every
	 * other surface serves normally.
	 */
	openrouterApiKey?: string;
	/** Upstream base URL the gateway forwards to. */
	openrouterBaseUrl: string;
	/**
	 * HMAC secret for per-Conversation gateway tokens. Mint (at VM launch) and
	 * verify (on every gateway request) both live in chat-api, so the secret
	 * never leaves this process. Optional alongside `openrouterApiKey`.
	 */
	gatewayTokenSecret?: string;
}

/**
 * Parse + validate the environment into a typed config. Pure: env in, config
 * out. Worker-only secrets (KB, E2B) are intentionally not read here; the
 * OpenRouter credential is read for the /v2 gateway (ADR-0034) and nothing
 * else.
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

	const statsigServerSecret = env.STATSIG_SERVER_SECRET?.trim();
	assert(statsigServerSecret, "STATSIG_SERVER_SECRET is required");

	return {
		logLevel: env.LOG_LEVEL || "info",
		databaseUrl,
		artifactBucket,
		artifactRegion,
		statsigServerSecret,
		redisUrl: resolveLiveStreamRedisUrl(env.REDIS_URL, {
			allowInsecureLoopback:
				env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS === "true",
		}),
		openrouterApiKey: env.OPENROUTER_API_KEY?.trim() || undefined,
		openrouterBaseUrl:
			env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api",
		gatewayTokenSecret: env.GATEWAY_TOKEN_SECRET?.trim() || undefined,
	};
}
