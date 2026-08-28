import { z } from "zod";

/**
 * Configuration for the Harness-hosted AI SDK chat route. Read only by the
 * local composition (`local/index.ts`); production `ApiConfig` deliberately
 * never carries the Vercel triple or the OpenRouter credential.
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
	// Maximum wall-clock lifetime of one Harness sandbox session.
	HARNESS_SANDBOX_TIMEOUT_MS: z.coerce
		.number()
		.int()
		.positive()
		.default(600_000),
	// Vercel region; snapshots are region-bound, so this is project-level.
	HARNESS_SANDBOX_REGION: z.string().trim().min(1).default("iad1"),
	// The Conversation's E2B Workspace, attached per Harness turn without a Run.
	// The Runtime's variable names, so Compose exports each secret once.
	E2B_API_KEY: z.string().trim().min(1),
	WORKER_E2B_TEMPLATE: z.string().trim().min(1).default("mymemo-agent-sandbox"),
});

export type HarnessConfig = z.infer<typeof harnessEnv>;

export function loadHarnessConfigFromEnv(
	env: Record<string, string | undefined>,
): HarnessConfig {
	const parsed = harnessEnv.safeParse(env);
	if (!parsed.success) throw new Error(z.prettifyError(parsed.error));
	return parsed.data;
}
