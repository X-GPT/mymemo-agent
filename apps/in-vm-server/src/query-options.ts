import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { InVmConfig } from "./config";

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
}): Options {
	return {
		cwd: input.workspaceDir,
		// Provider envelope boundaries are the durable Step contract, so partial
		// SDK stream events are required for live text/reasoning deltas.
		includePartialMessages: true,
		// No user/project/local settings, hooks, skills, or CLAUDE.md — the
		// managed policy tier baked into the image (#661) is still read.
		settingSources: [],
		// Only MCP servers passed via `mcpServers` (none yet; #665 adds the doc
		// tools) — ignores .mcp.json, ~/.claude.json and plugin config.
		strictMcpConfig: true,
		// Unresolved permission requests are terminal denials; canUseTool never
		// fires. Confinement is the scoped allows below, not a callback.
		permissionMode: "dontAsk",
		// Scoped allows, never bare Read/Edit — a bare entry would auto-approve
		// the whole tool anywhere on disk. Read(./**) best-effort covers
		// Grep/Glob; Edit(./**) covers Write and NotebookEdit.
		allowedTools: ["Read(./**)", "Edit(./**)", "Grep", "Glob", "Bash"],
		// In-process network tools bypass the Bash sandbox's proxy; the VM's
		// egress firewall is the production backstop, but deny them at the
		// source so local runs are confined the same way.
		disallowedTools: ["WebFetch", "WebSearch"],
		sandbox: {
			enabled: true,
			// Never silently run commands unsandboxed — the single most
			// load-bearing key in the bundle (#645).
			failIfUnavailable: true,
			// The model cannot route around a sandbox denial with
			// dangerouslyDisableSandbox.
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			// Network deny-all for Bash: empty allowlist + deterministic deny
			// (no prompting) closes IMDS and RDS-at-IP from the sandbox.
			network: {
				allowedDomains: [],
				strictAllowlist: true,
			},
		},
		model: input.model.model,
		env: buildCliEnv(input.processEnv, input.model),
	};
}
