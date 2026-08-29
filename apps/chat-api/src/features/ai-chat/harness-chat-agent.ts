import { HarnessAgent } from "@ai-sdk/harness/agent";
import { createClaudeCode } from "@ai-sdk/harness-claude-code";
import { createVercelSandbox } from "@ai-sdk/sandbox-vercel";
import type { HarnessConfig } from "@/config/harness-env";
import type { DocumentAccessLog } from "./tools/document-access-log";
import {
	createKbDb,
	createScopedDocumentClient,
	type DocumentClientLogger,
	type FrozenScope,
	type HarnessToolBinding,
} from "./tools/document-client";
import {
	createHarnessTools,
	HARNESS_ACTIVE_TOOLS,
	type HarnessToolLogger,
} from "./tools/harness-tools";

/** What one Harness turn binds its document tools to. */
export interface HarnessTurn {
	binding: HarnessToolBinding;
	scope: FrozenScope;
	audit: DocumentAccessLog;
	logger: HarnessToolLogger & DocumentClientLogger;
}

/** Builds the `HarnessAgent` for one turn over that turn's document tools; tests inject a cast fake. */
export type HarnessChatAgentFactory = ReturnType<
	typeof createHarnessChatAgentFactory
>;

/**
 * Appended to Claude Code's native prompt (the bridge hardcodes the `claude_code`
 * preset — ADR-0033), which still describes every Claude Code tool, so the
 * model is told which are real here.
 */
export const HARNESS_INSTRUCTIONS =
	"You are MyMemo's agent. You answer the user's questions and do file-backed work on their behalf.\n\n" +
	"Your tools are Read, Write, Edit, and Grep on your working directory, plus the MyMemo tools in your " +
	"tool list, which you call by their short names. Nothing else exists: no shell, no web access, no " +
	"sub-agents, and no other built-in tool your other instructions mention. Work in your working " +
	"directory with relative paths; files you create there persist between messages of this " +
	"conversation. If no tool can do what is asked, say plainly that you cannot do it in this " +
	"conversation.\n\n" +
	"Keep responses concise.";

/** Port inside the sandbox the Claude Code bridge listens on (adapter uses `ports[0]`; any free port works). */
const BRIDGE_PORT = 4000;

/**
 * Composition-time Claude Code adapter, Vercel Sandbox provider, and read-only
 * KB pool, shared by every turn; the returned factory builds one `HarnessAgent`
 * per turn over that turn's document tools. The adapter with `auth: 'direct'` reads
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
	const kb = createKbDb(config.KB_DATABASE_URL);
	return (turn: HarnessTurn) => {
		const { tools, onSession } = createHarnessTools({
			client: createScopedDocumentClient({ kb, ...turn }),
			binding: turn.binding,
			logger: turn.logger,
		});
		return new HarnessAgent({
			harness,
			sandbox,
			tools,
			activeTools: HARNESS_ACTIVE_TOOLS,
			instructions: HARNESS_INSTRUCTIONS,
			// Tells LoadDocuments the session work directory (fresh and resumed).
			sandboxConfig: { onSession },
		});
	};
}
