import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { resolveLiveStreamRedisUrl } from "@mymemo/live-text";

/** Subset of the process environment the In-VM server reads. */
export type Env = Record<string, string | undefined>;

/**
 * Assert a config invariant, throwing an Error whose message survives
 * production builds (deliberately not tiny-invariant — see chat-api's env
 * loader for the rationale).
 */
function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

/**
 * Typed, validated configuration for the trusted In-VM server's Turn serving
 * (spec #654, ticket #662). Locally it is built from the environment at the
 * entrypoint; in the MicroVM it is built when the platform `/run` lifecycle
 * hook delivers `runHookPayload` (#666) — either way it is injected down, so
 * no other module reads global env. The data-plane credentials here (agent DB,
 * Redis) live in this trusted process only — they are never placed in the
 * spawned CLI's environment (see `query-options.ts`).
 *
 * The HTTP listener's own settings (`PORT`, `LOG_LEVEL`) are deliberately not
 * here: the server must listen before any Conversation is assigned (the image
 * build's `/ready` hook fires with no configuration at all), so the entrypoint
 * reads them straight from the image-level environment.
 */
export interface InVmConfig {
	/** Writable connection to the agent Postgres (`mymemo_agent`) — the work bus. */
	databaseUrl: string;
	/**
	 * Read-only connection to the KB Postgres (`mymemo_kb`) for the in-process
	 * document tools (#665). Held by this trusted process only — the CLI env
	 * allowlist can never carry it.
	 */
	kbDatabaseUrl: string;
	/** Redis connection for the v2 Turn Live Stream lane. */
	redisUrl: string;
	/**
	 * The Conversation this VM serves — one VM per Conversation. Locally these
	 * are plain env vars; in production they arrive via `runHookPayload` at VM
	 * boot, with no design change here.
	 */
	userId: string;
	conversationId: string;
	/** The Workspace — the cwd the confined file tools act in. */
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
	/**
	 * chat-api's `/v2/checkpoint/<conversation>` door (#670), delivered via
	 * `runHookPayload`; the gateway token above authenticates it. Absent
	 * locally, where no lifecycle hook ever fires.
	 */
	checkpointUrl?: string;
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

	const kbDatabaseUrl = env.KB_DATABASE_URL?.trim();
	assert(kbDatabaseUrl, "KB_DATABASE_URL is required");

	const userId = env.MYMEMO_USER_ID?.trim();
	assert(userId, "MYMEMO_USER_ID is required");
	const conversationId = env.MYMEMO_CONVERSATION_ID?.trim();
	assert(conversationId, "MYMEMO_CONVERSATION_ID is required");
	// The Conversation id is also the Agent session id (#670), which the SDK
	// requires to be a UUID — chat-api mints them with crypto.randomUUID().
	assert(
		/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
			conversationId,
		),
		"MYMEMO_CONVERSATION_ID must be a UUID",
	);

	const workspaceDir = env.WORKSPACE_DIR?.trim();
	assert(workspaceDir, "WORKSPACE_DIR is required");

	const modelBaseUrl = env.MODEL_BASE_URL?.trim().replace(/\/+$/, "");
	assert(modelBaseUrl, "MODEL_BASE_URL is required");
	const modelApiKey = env.MODEL_API_KEY?.trim();
	assert(modelApiKey, "MODEL_API_KEY is required");
	const model = env.MODEL?.trim();
	assert(model, "MODEL is required");

	return {
		databaseUrl,
		kbDatabaseUrl,
		redisUrl: resolveLiveStreamRedisUrl(env.REDIS_URL, {
			allowInsecureLoopback:
				env.LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS === "true",
		}),
		userId,
		conversationId,
		workspaceDir,
		model: { baseUrl: modelBaseUrl, apiKey: modelApiKey, model },
		checkpointUrl: env.CHECKPOINT_URL?.trim() || undefined,
	};
}

/**
 * Parse the `runHookPayload` string the platform delivers to the `/run`
 * lifecycle hook (#666) into env-shaped overrides for `loadInVmConfigFromEnv`.
 * The payload is a JSON object whose keys are exactly the env names documented
 * for this server (AGENT_DATABASE_URL, REDIS_URL, MYMEMO_USER_ID, …), so local
 * env delivery and production payload delivery share one contract and one
 * validator. Fails loudly on anything else — a malformed payload must fail the
 * run hook, not boot a half-configured VM.
 */
export function envFromRunHookPayload(payload: unknown): Env {
	assert(
		typeof payload === "string" && payload.length > 0,
		"runHookPayload is required and must be a string",
	);
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error("runHookPayload is not valid JSON");
	}
	assert(
		typeof parsed === "object" && parsed !== null && !Array.isArray(parsed),
		"runHookPayload must be a JSON object of env-shaped keys",
	);
	for (const [key, value] of Object.entries(parsed)) {
		assert(
			typeof value === "string",
			`runHookPayload value for ${key} must be a string`,
		);
	}
	return parsed as Env;
}
