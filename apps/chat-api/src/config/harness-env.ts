import { z } from "zod";

/**
 * Configuration for the Harness-hosted AI SDK chat route. Read only by the
 * local composition (`local/index.ts`); production `ApiConfig` deliberately
 * never carries the Vercel triple, the OpenRouter credential, or the KB URL.
 */
const harnessEnv = z.object({
	// Explicit Vercel Sandbox credentials; `@vercel/sandbox` does not read env.
	VERCEL_TOKEN: z.string().trim().min(1),
	VERCEL_TEAM_ID: z.string().trim().min(1),
	VERCEL_PROJECT_ID: z.string().trim().min(1),
	// Model credential set on the chat-api process for the Claude Code adapter.
	OPENROUTER_API_KEY: z.string().trim().min(1),
	OPENROUTER_BASE_URL: z
		.string()
		.trim()
		.min(1)
		.default("https://openrouter.ai/api"),
	OPENROUTER_DEFAULT_MODEL: z
		.string()
		.trim()
		.min(1)
		.default("anthropic/claude-sonnet-5"),
	// Read-only KB the document tools query in this process (ADR-0033 stage 2).
	KB_DATABASE_URL: z.string().trim().min(1),
	// Maximum wall-clock lifetime of one Harness sandbox session.
	HARNESS_SANDBOX_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(600_000),
	// Vercel region; snapshots are region-bound, so this is project-level.
	HARNESS_SANDBOX_REGION: z.string().trim().min(1).default("iad1"),
});

export type HarnessConfig = z.infer<typeof harnessEnv>;

export function loadHarnessConfigFromEnv(
	env: Record<string, string | undefined>,
): HarnessConfig {
	const parsed = harnessEnv.safeParse(env);
	if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
	return parsed.data;
}
