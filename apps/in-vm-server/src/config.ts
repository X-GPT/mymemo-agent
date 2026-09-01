import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";

/** Subset of the process environment the In-VM server reads. */
type Env = Record<string, string | undefined>;

/**
 * Assert a config invariant, throwing an Error whose message survives
 * production builds (deliberately not tiny-invariant — see chat-api's env
 * loader for the rationale).
 */
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/**
 * Typed, validated configuration for the trusted In-VM server (spec #654,
 * ticket #662). Built once from the environment at the entrypoint and injected
 * down, so no other module reads global env. The data-plane credentials here
 * (agent DB, Redis) live in this trusted process only — they are never placed
 * in the spawned CLI's environment (see `query-options.ts`).
 */
export interface InVmConfig {
	/** pino log level. */
	logLevel: string;
	/** HTTP port for the nudge + health endpoints. */
	port: number;
	/** Writable connection to the agent Postgres (`mymemo_agent`) — the work bus. */
	databaseUrl: string;
	/** Redis connection for the v2 Turn Live Stream lane. */
	redisUrl: string;
	/**
	 * The Conversation this VM serves — one VM per Conversation. Locally these
	 * are plain env vars; in production (#666) they arrive via `runHookPayload`
	 * at VM boot, with no design change here.
	 */
	userId: string;
	conversationId: string;
	/** The Workspace — the cwd the confined file tools and sandboxed Bash act in. */
	workspaceDir: string;
	/**
	 * Model access for the trusted process: locally a direct provider base
	 * URL/key; in production the chat-api gateway route and the
	 * per-Conversation gateway token. Same shape either way (spec #654).
	 */
	model: {
		baseUrl: string;
		apiKey: string;
		model: string;
	};
}

/** Parse + validate the environment into a typed config. Pure: env in, config out. */
export function loadInVmConfigFromEnv(env: Env): InVmConfig {
	// Sourced from AGENT_DATABASE_URL (the writable mymemo_agent DB), never the
	// generic DATABASE_URL — that name is the read-only KB credential elsewhere
	// in the repo.
	const databaseUrl = resolveDatabaseUrl(
		env.AGENT_DATABASE_URL,
		env.DB_PASSWORD,
		env.DB_SSL,
	);
	assert(databaseUrl, "AGENT_DATABASE_URL is required");

	const userId = env.MYMEMO_USER_ID?.trim();
	assert(userId, "MYMEMO_USER_ID is required");
	const conversationId = env.MYMEMO_CONVERSATION_ID?.trim();
	assert(conversationId, "MYMEMO_CONVERSATION_ID is required");

	const workspaceDir = env.WORKSPACE_DIR?.trim();
	assert(workspaceDir, "WORKSPACE_DIR is required");

	const modelBaseUrl = env.MODEL_BASE_URL?.trim().replace(/\/+$/, "");
	assert(modelBaseUrl, "MODEL_BASE_URL is required");
	const modelApiKey = env.MODEL_API_KEY?.trim();
	assert(modelApiKey, "MODEL_API_KEY is required");
	const model = env.MODEL?.trim();
	assert(model, "MODEL is required");

	const port = env.PORT === undefined ? 8080 : Number(env.PORT);
	assert(
		Number.isSafeInteger(port) && port > 0,
		"PORT must be a positive integer",
	);

	return {
		logLevel: env.LOG_LEVEL || "info",
		port,
		databaseUrl,
		redisUrl: resolveLiveStreamRedisUrl(env.REDIS_URL, {
			allowInsecureLoopback:
				env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS === "true",
		}),
		userId,
		conversationId,
		workspaceDir,
		model: { baseUrl: modelBaseUrl, apiKey: modelApiKey, model },
	};
}
