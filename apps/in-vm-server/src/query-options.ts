import type {
	McpSdkServerConfigWithInstance,
	Options,
} from "@anthropic-ai/claude-agent-sdk";
import type { InVmConfig } from "./config";
import { DOC_TOOLS_ALLOWED_TOOLS, DOC_TOOLS_SERVER_NAME } from "./doc-tools";

/**
 * The confinement settings bundle for the In-VM `query()` (spec #654; the
 * exact keys and their rationale are the tool-confinement research note on
 * `research/agent-sdk-confinement`, resolved by #645). The spawned CLI is the
 * untrusted surface: its environment is built from an allowlist so no
 * data-plane credential (agent DB, KB, Redis) can ever reach it — the model
 * credential is deliberately present, because in production it is the
 * per-Conversation gateway token, not a data-plane secret.
 */

/**
 * Process-env keys the CLI subprocess legitimately needs. Everything else —
 * including every credential the trusted server holds — is dropped. An
 * allowlist rather than a denylist so a new server-side secret is excluded by
 * default instead of leaking by default.
 */
const CLI_ENV_ALLOWLIST = [
	"PATH",
	"HOME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"TERM",
] as const;

/**
 * Build the credential-free environment for the spawned CLI. `Options.env`
 * REPLACES the subprocess environment (it is not merged), so this is the
 * complete env the untrusted surface ever sees.
 */
export function buildCliEnv(
	processEnv: Record<string, string | undefined>,
	model: InVmConfig["model"],
): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = {};
	for (const key of CLI_ENV_ALLOWLIST) {
		if (processEnv[key] !== undefined) env[key] = processEnv[key];
	}
	// Model access rides the Anthropic-compatible env contract (agentcore
	// precedent): base URL + Bearer token, with the first-party key pinned
	// empty so the SDK can never fall back to an ambient credential.
	env.ANTHROPIC_BASE_URL = model.baseUrl;
	env.ANTHROPIC_AUTH_TOKEN = model.apiKey;
	env.ANTHROPIC_API_KEY = "";
	// Auto memory loads regardless of settingSources; a multi-tenant runtime
	// must not carry prompt-level state between sessions behind our back.
	env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
	return env;
}

/** Assemble the fail-closed SDK query options for one Turn. */
export function buildTurnQueryOptions(input: {
	workspaceDir: string;
	model: InVmConfig["model"];
	processEnv: Record<string, string | undefined>;
	/**
	 * The exec-verified native CLI binary (see `claude-code-executable.ts`) —
	 * explicit because the SDK's musl-first Linux default cannot execute on the
	 * glibc MicroVM image.
	 */
	pathToClaudeCodeExecutable: string;
	/** The in-process document tools (#665), built once per configuration. */
	docToolsServer: McpSdkServerConfigWithInstance;
}): Options {
	return {
		cwd: input.workspaceDir,
		pathToClaudeCodeExecutable: input.pathToClaudeCodeExecutable,
		// Provider envelope boundaries are the durable Step contract, so partial
		// SDK stream events are required for live text/reasoning deltas.
		includePartialMessages: true,
		// No user/project/local settings, hooks, skills, or CLAUDE.md — the
		// managed policy tier baked into the image (#661) is still read.
		settingSources: [],
		// Only MCP servers passed via `mcpServers` (exactly the in-process doc
		// tools below) — ignores .mcp.json, ~/.claude.json and plugin config.
		strictMcpConfig: true,
		// The document tools execute in this trusted process (#665); the CLI
		// sees only the tool surface, never the KB credential behind it.
		mcpServers: { [DOC_TOOLS_SERVER_NAME]: input.docToolsServer },
		// Unresolved permission requests are terminal denials; canUseTool never
		// fires. Confinement is the scoped allows below, not a callback.
		permissionMode: "dontAsk",
		// Scoped allows, never bare Read/Edit — a bare entry would auto-approve
		// the whole tool anywhere on disk. Read(./**) best-effort covers
		// Grep/Glob; Edit(./**) covers Write and NotebookEdit.
		allowedTools: [
			"Read(./**)",
			"Edit(./**)",
			"Grep",
			"Glob",
			...DOC_TOOLS_ALLOWED_TOOLS,
		],
		// Bash is DENIED, not merely unlisted (#692). Sandbox-mode Bash cannot
		// start in the MicroVM — bwrap cannot mount /proc there — and running
		// it unsandboxed would hand the untrusted surface the VM's network:
		// IMDS (hence the execution role's cross-Conversation checkpoint
		// scope), the gateway token's model spend, and a DNS exfil path. The
		// shell returns when #692 resolves, not before. BashOutput/KillShell
		// manage background shells and go with it.
		// WebFetch/WebSearch are in-process network tools that bypass the
		// sandbox proxy entirely; the VM's egress firewall is the production
		// backstop, but deny them at the source so local runs match.
		disallowedTools: [
			"Bash",
			"BashOutput",
			"KillShell",
			"WebFetch",
			"WebSearch",
		],
		// Inert while Bash is denied — kept so that re-enabling the shell
		// fails closed instead of silently running unsandboxed (#645).
		sandbox: {
			enabled: true,
			// Never silently run commands unsandboxed — the single most
			// load-bearing key in the bundle.
			failIfUnavailable: true,
			// The model cannot route around a sandbox denial with
			// dangerouslyDisableSandbox.
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			// Network deny-all: empty allowlist + deterministic deny (no
			// prompting) closes IMDS and RDS-at-IP from any sandboxed command.
			network: {
				allowedDomains: [],
				strictAllowlist: true,
			},
		},
		model: input.model.model,
		env: buildCliEnv(input.processEnv, input.model),
	};
}
