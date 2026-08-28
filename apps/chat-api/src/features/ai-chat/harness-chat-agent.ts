import { HarnessAgent, type HarnessAgentSettings } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { HarnessConfig } from "@/config/harness-env";
import { HARNESS_ACTIVE_TOOLS } from "./tools/harness-tools";

/** Builds the `HarnessAgent` for one turn over that turn's user-tool set; tests inject a cast fake. */
export type HarnessChatAgentFactory = ReturnType<
	typeof createHarnessChatAgentFactory
>;

/**
 * Appended to Claude Code's native system prompt (the bridge hardcodes the
 * `claude_code` preset, so this path can only append — ADR-0033). That preset
 * still describes every Claude Code tool, so the model must be told which
 * ones are real here: seen live, with nothing listed it can write a tool call
 * out as text and invent the result. The first paragraph is MyMemo's role
 * line from the Runtime's `MYMEMO_SYSTEM_PROMPT` (accepted drift: a wording
 * change there is applied here too).
 */
export const HARNESS_INSTRUCTIONS =
	"You are MyMemo's agent. You answer the user's questions and do file-backed work on their behalf.\n\n" +
	"Your tools are Read, Write, Edit, and Grep on your working directory, plus the MyMemo tools in your " +
	"tool list, which you call by their short names. Nothing else exists: no shell, no web access, no " +
	"sub-agents, and no other built-in tool your other instructions mention. Work in your working " +
	"directory with relative paths; files you create there persist between messages of this " +
	"conversation. Never write a tool call out as text and never invent a tool's output. If no tool " +
	"can do what is asked, say plainly that you cannot do it in this conversation.\n\n" +
	"Keep responses concise.";

/** Port inside the sandbox the Claude Code bridge listens on (adapter uses `ports[0]`; any free port works). */
const BRIDGE_PORT = 4000;

/**
 * Composition-time Claude Code adapter and Vercel Sandbox provider, shared by
 * every turn; the returned factory builds one `HarnessAgent` per turn over
 * that turn's tools. The adapter with `auth: 'direct'` reads
 * `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` from this process and brokers
 * them: the sandbox only ever sees a placeholder that the Vercel firewall
 * swaps for the real bearer on requests to that host. `auto` would instead
 * route the model call to the AI Gateway via the local `VERCEL_OIDC_TOKEN`.
 */
export function createHarnessChatAgentFactory(config: HarnessConfig) {
	process.env.ANTHROPIC_BASE_URL = config.OPENROUTER_BASE_URL;
	process.env.ANTHROPIC_AUTH_TOKEN = config.OPENROUTER_API_KEY;
	// Load-bearing: the adapter forwards a non-empty `ANTHROPIC_API_KEY` from
	// this process alongside the auth token, so a real key exported in the shell
	// would be brokered into the sandbox too. Empty means "none".
	process.env.ANTHROPIC_API_KEY = "";
	const harness = createClaudeCode({
		auth: "direct",
		model: config.OPENROUTER_DEFAULT_MODEL,
		// Adapter-default thinking: reasoning reaches the client as `reasoning-*`
		// parts. Tool search off so no user tool is deferred to the CLI's ToolSearch.
		env: { ENABLE_TOOL_SEARCH: "false" },
	});
	const sandbox = createVercelSandbox({
		token: config.VERCEL_TOKEN,
		teamId: config.VERCEL_TEAM_ID,
		projectId: config.VERCEL_PROJECT_ID,
		runtime: "node24",
		ports: [BRIDGE_PORT],
		timeout: config.HARNESS_SANDBOX_TIMEOUT_MS,
		region: config.HARNESS_SANDBOX_REGION,
		keepLastSnapshots: { count: 1 },
	});
	// `tools` is this turn's user-tool set, keyed by `HARNESS_TOOL_NAMES`.
	return (tools: NonNullable<HarnessAgentSettings["tools"]>) =>
		new HarnessAgent({
			harness,
			sandbox,
			tools,
			// The four built-ins plus the user-tool names: the bridge turns this
			// into Agent SDK `tools: [Read, Write, Edit, Grep]` plus
			// `disallowedTools` for every other native name, and — under the
			// default `allow-all` permissionMode — allows the active natives
			// without approval and auto-denies any request for an inactive one.
			activeTools: HARNESS_ACTIVE_TOOLS,
			instructions: HARNESS_INSTRUCTIONS,
		});
}
