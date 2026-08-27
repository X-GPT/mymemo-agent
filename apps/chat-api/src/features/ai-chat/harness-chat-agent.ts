import { HarnessAgent, type HarnessAgentSession } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { HarnessConfig } from "@/config/harness-env";

/** One Harness sandbox session; the route destroys it after the turn. */
export interface HarnessChatSession {
	destroy(): Promise<void>;
}

/**
 * The route's view of `HarnessAgent`: create a session named after the
 * Conversation, stream one turn, destroy the session. Route tests inject a
 * fake; the local composition injects the real Vercel-backed agent.
 */
export interface HarnessChatAgent {
	createSession(options: { sessionId: string }): Promise<HarnessChatSession>;
	stream(options: {
		session: HarnessChatSession;
		prompt: string;
		abortSignal?: AbortSignal;
	}): Promise<{ toUIMessageStreamResponse(): Response }>;
}

/** Port inside the sandbox the Claude Code bridge listens on. */
const BRIDGE_PORT = 4000;

/**
 * Real `HarnessAgent` over a Vercel Sandbox. The Claude Code adapter with
 * `auth: 'direct'` reads `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from
 * this process and brokers them: the sandbox only ever sees a placeholder that
 * the Vercel firewall swaps for the real bearer on requests to that host.
 * `auto` would instead route the model call to the AI Gateway via the local
 * `VERCEL_OIDC_TOKEN`.
 */
export function createHarnessChatAgent(
	config: HarnessConfig,
): HarnessChatAgent {
	process.env.ANTHROPIC_BASE_URL = config.openrouterBaseUrl;
	process.env.ANTHROPIC_AUTH_TOKEN = config.openrouterApiKey;
	process.env.ANTHROPIC_API_KEY = "";
	const agent = new HarnessAgent({
		harness: createClaudeCode({
			auth: "direct",
			model: config.model,
			thinking: { type: "disabled" },
		}),
		sandbox: createVercelSandbox({
			...config.vercel,
			runtime: "node24",
			ports: [BRIDGE_PORT],
			timeout: config.sandboxTimeoutMs,
			region: config.sandboxRegion,
			keepLastSnapshots: { count: 1 },
		}),
	});
	return {
		createSession: (options) => agent.createSession(options),
		stream: ({ session, ...rest }) =>
			agent.stream({ ...rest, session: session as HarnessAgentSession }),
	};
}
