import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { HarnessConfig } from "@/config/harness-env";

/** The `HarnessAgent` the route drives; tests inject a cast fake. */
export type HarnessChatAgent = ReturnType<typeof createHarnessChatAgent>;

/** Port inside the sandbox the Claude Code bridge listens on (adapter uses `ports[0]`; any free port works). */
const BRIDGE_PORT = 4000;

/**
 * Real `HarnessAgent` over a Vercel Sandbox. The Claude Code adapter with
 * `auth: 'direct'` reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from
 * this process and brokers them: the sandbox only ever sees a placeholder that
 * the Vercel firewall swaps for the real bearer on requests to that host.
 * `auto` would instead route the model call to the AI Gateway via the local
 * `VERCEL_OIDC_TOKEN`.
 */
export function createHarnessChatAgent(config: HarnessConfig) {
	process.env.ANTHROPIC_BASE_URL = config.OPENROUTER_BASE_URL;
	process.env.ANTHROPIC_AUTH_TOKEN = config.OPENROUTER_API_KEY;
	// Load-bearing: the adapter forwards a non-empty `ANTHROPIC_API_KEY` from
	// this process alongside the auth token, so a real key exported in the shell
	// would be brokered into the sandbox too. Empty means "none".
	process.env.ANTHROPIC_API_KEY = "";
	return new HarnessAgent({
		harness: createClaudeCode({
			auth: "direct",
			model: config.OPENROUTER_DEFAULT_MODEL,
			// First slice runs without extended thinking; revisit with stage 2.
			thinking: { type: "disabled" },
		}),
		sandbox: createVercelSandbox({
			token: config.VERCEL_TOKEN,
			teamId: config.VERCEL_TEAM_ID,
			projectId: config.VERCEL_PROJECT_ID,
			runtime: "node24",
			ports: [BRIDGE_PORT],
			timeout: config.HARNESS_SANDBOX_TIMEOUT_MS,
			region: config.HARNESS_SANDBOX_REGION,
			keepLastSnapshots: { count: 1 },
		}),
	});
}
