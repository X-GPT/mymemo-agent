/**
 * Configuration for the Harness-hosted AI SDK chat route. Read only by the
 * local composition (`local/index.ts`); production `ApiConfig` deliberately
 * never carries the Vercel triple or the OpenRouter credential.
 */
export interface HarnessConfig {
	/** Explicit Vercel Sandbox credentials; `@vercel/sandbox` does not read env. */
	vercel: { token: string; teamId: string; projectId: string };
	/** Model credential set on the chat-api process for the Claude Code adapter. */
	openrouterApiKey: string;
	openrouterBaseUrl: string;
	/** Model the Claude Code adapter runs (`OPENROUTER_DEFAULT_MODEL`). */
	model: string;
	/** Maximum wall-clock lifetime of one Harness sandbox session. */
	sandboxTimeoutMs: number;
	/** Vercel region; snapshots are region-bound, so this is project-level. */
	sandboxRegion: string;
}

type Env = Record<string, string | undefined>;

function required(env: Env, name: string): string {
	const value = env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

export function loadHarnessConfigFromEnv(env: Env): HarnessConfig {
	const timeout = env.HARNESS_SANDBOX_TIMEOUT_MS?.trim();
	const sandboxTimeoutMs = timeout ? Number(timeout) : 600_000;
	if (!Number.isInteger(sandboxTimeoutMs) || sandboxTimeoutMs <= 0) {
		throw new Error("HARNESS_SANDBOX_TIMEOUT_MS must be a positive integer");
	}
	return {
		vercel: {
			token: required(env, "VERCEL_TOKEN"),
			teamId: required(env, "VERCEL_TEAM_ID"),
			projectId: required(env, "VERCEL_PROJECT_ID"),
		},
		openrouterApiKey: required(env, "OPENROUTER_API_KEY"),
		openrouterBaseUrl:
			env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api",
		model: env.OPENROUTER_DEFAULT_MODEL?.trim() || "anthropic/claude-sonnet-5",
		sandboxTimeoutMs,
		sandboxRegion: env.HARNESS_SANDBOX_REGION?.trim() || "iad1",
	};
}
