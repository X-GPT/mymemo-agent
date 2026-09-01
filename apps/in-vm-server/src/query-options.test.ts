import { describe, expect, it } from "bun:test";
import { buildCliEnv, buildTurnQueryOptions } from "./query-options";

/**
 * The confinement bundle is a security contract (spec #654 acceptance:
 * "Confinement bundle asserted in config/tests; the spawned CLI env carries no
 * data-plane credential"). These tests pin every load-bearing key so a drift
 * fails loudly.
 */

const MODEL = {
	baseUrl: "https://openrouter.ai/api",
	apiKey: "sk-model",
	model: "anthropic/claude-sonnet-5",
};

/** A trusted-process env poisoned with every data-plane credential we hold. */
function trustedProcessEnv(): Record<string, string | undefined> {
	return {
		PATH: "/usr/bin:/bin",
		HOME: "/home/developer",
		SHELL: "/bin/bash",
		TMPDIR: "/tmp",
		LANG: "en_US.UTF-8",
		TERM: "xterm",
		AGENT_DATABASE_URL: "postgresql://u:secret@db:5432/mymemo_agent",
		KB_DATABASE_URL: "postgresql://kb:secret@db:5432/mymemo_kb",
		DB_PASSWORD: "db-secret",
		REDIS_URL: "rediss://default:redis-secret@redis:6379",
		MODEL_API_KEY: "sk-model",
		AWS_ACCESS_KEY_ID: "AKIA-nope",
		AWS_SECRET_ACCESS_KEY: "aws-secret",
		SOME_FUTURE_SECRET: "surprise",
	};
}

describe("buildCliEnv", () => {
	it("carries no data-plane credential — allowlist only", () => {
		const env = buildCliEnv(trustedProcessEnv(), MODEL);
		expect(Object.keys(env).sort()).toEqual(
			[
				"ANTHROPIC_API_KEY",
				"ANTHROPIC_AUTH_TOKEN",
				"ANTHROPIC_BASE_URL",
				"CLAUDE_CODE_DISABLE_AUTO_MEMORY",
				"HOME",
				"LANG",
				"PATH",
				"SHELL",
				"TERM",
				"TMPDIR",
			].sort(),
		);
	});

	it("routes the model through the configured base URL as a Bearer token", () => {
		const env = buildCliEnv(trustedProcessEnv(), MODEL);
		expect(env.ANTHROPIC_BASE_URL).toBe(MODEL.baseUrl);
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe(MODEL.apiKey);
		// Pinned empty so the SDK can never fall back to an ambient key.
		expect(env.ANTHROPIC_API_KEY).toBe("");
	});

	it("disables auto memory for the spawned CLI", () => {
		const env = buildCliEnv(trustedProcessEnv(), MODEL);
		expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
	});

	it("omits allowlisted keys the process env does not define", () => {
		const env = buildCliEnv({ PATH: "/bin" }, MODEL);
		expect("HOME" in env).toBe(false);
		expect(env.PATH).toBe("/bin");
	});
});

describe("buildTurnQueryOptions", () => {
	const options = buildTurnQueryOptions({
		workspaceDir: "/workspace/conversation-1",
		model: MODEL,
		processEnv: trustedProcessEnv(),
	});

	it("pins the confinement settings bundle", () => {
		expect(options.cwd).toBe("/workspace/conversation-1");
		expect(options.settingSources).toEqual([]);
		expect(options.strictMcpConfig).toBe(true);
		expect(options.permissionMode).toBe("dontAsk");
		expect(options.includePartialMessages).toBe(true);
		expect(options.model).toBe(MODEL.model);
	});

	it("scopes the file tools to the cwd — never a bare Read/Edit allow", () => {
		expect(options.allowedTools).toEqual([
			"Read(./**)",
			"Edit(./**)",
			"Grep",
			"Glob",
			"Bash",
		]);
		expect(options.disallowedTools).toEqual(["WebFetch", "WebSearch"]);
	});

	it("enforces OS-sandboxed Bash with network deny-all, failing closed", () => {
		expect(options.sandbox).toEqual({
			enabled: true,
			failIfUnavailable: true,
			allowUnsandboxedCommands: false,
			autoAllowBashIfSandboxed: true,
			network: { allowedDomains: [], strictAllowlist: true },
		});
	});

	it("hands the spawned CLI the credential-free env", () => {
		expect(options.env).toEqual(buildCliEnv(trustedProcessEnv(), MODEL));
		expect(options.env?.AGENT_DATABASE_URL).toBeUndefined();
		expect(options.env?.REDIS_URL).toBeUndefined();
	});
});
