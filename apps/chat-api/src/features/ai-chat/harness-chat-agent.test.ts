import { afterAll, expect, it, spyOn } from "bun:test";
import * as claudeCode from "@ai-sdk/harness-claude-code";
import type { HarnessConfig } from "@/config/harness-env";
import {
	createHarnessChatAgentFactory,
	HARNESS_INSTRUCTIONS,
	type HarnessTurn,
} from "./harness-chat-agent";
import {
	HARNESS_ACTIVE_TOOLS,
	HARNESS_BUILTIN_TOOLS,
	HARNESS_TOOL_NAMES,
} from "./tools/harness-tools";

const config: HarnessConfig = {
	VERCEL_TOKEN: "test-vercel-token",
	VERCEL_TEAM_ID: "team_test",
	VERCEL_PROJECT_ID: "prj_test",
	OPENROUTER_API_KEY: "test-openrouter-key",
	OPENROUTER_BASE_URL: "https://openrouter.example",
	OPENROUTER_DEFAULT_MODEL: "anthropic/claude-sonnet-5",
	KB_DATABASE_URL: "postgresql://kb:kb@localhost:5432/mymemo_kb",
	HARNESS_SANDBOX_TIMEOUT_MS: 600_000,
	HARNESS_SANDBOX_REGION: "iad1",
};

// Pass-through spy on the adapter constructor; restored with the env below.
const createClaudeCode = spyOn(claudeCode, "createClaudeCode");

// The factory sets the adapter's credentials on this process; put them back.
const savedEnv = {
	ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
	ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
	ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
};
afterAll(() => {
	createClaudeCode.mockRestore();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
});

/** `HarnessAgent` keeps its settings private; read them for the pin. */
type Inspected = {
	settings: Record<string, unknown> & {
		sandboxConfig?: { onSession?: unknown };
	};
	builtinToolFiltering: unknown;
};

const turn: HarnessTurn = {
	binding: { userId: "member-1", conversationId: "conv-1", turnId: "turn-1" },
	scope: { type: "general" },
	audit: { record: async () => {} },
	logger: { info() {}, error() {} },
};

it("configures the Claude Code adapter once, with only Read, Write, Edit, and Grep on and tool search disabled", () => {
	const createAgent = createHarnessChatAgentFactory(config);
	const first = createAgent(turn) as unknown as Inspected;
	const second = createAgent(turn) as unknown as Inspected;

	// Built once at composition, shared by every turn's agent.
	expect(createClaudeCode).toHaveBeenCalledTimes(1);
	expect(createClaudeCode.mock.calls[0]).toEqual([
		{
			auth: "direct",
			model: "anthropic/claude-sonnet-5",
			env: { ENABLE_TOOL_SEARCH: "false" },
		},
	]);
	expect(second.settings.harness).toBe(first.settings.harness);
	expect(second.settings.sandbox).toBe(first.settings.sandbox);

	// Per turn: this turn's document tools, told the work directory through
	// `onSession`; the framework derives the built-in allow-list from activeTools.
	expect(Object.keys(first.settings.tools as object)).toEqual([
		...HARNESS_TOOL_NAMES,
	]);
	expect(first.settings.tools).not.toBe(second.settings.tools);
	expect(first.settings.sandboxConfig?.onSession).toBeFunction();
	expect(first.settings.activeTools).toBe(HARNESS_ACTIVE_TOOLS);
	expect(HARNESS_ACTIVE_TOOLS).toEqual([
		"read",
		"write",
		"edit",
		"grep",
		...HARNESS_TOOL_NAMES,
	]);
	expect(first.builtinToolFiltering).toEqual({
		mode: "allow",
		toolNames: [...HARNESS_BUILTIN_TOOLS],
	});
	expect(first.settings.permissionMode).toBeUndefined();
	expect(first.settings.instructions).toBe(HARNESS_INSTRUCTIONS);
	expect(process.env.ANTHROPIC_API_KEY).toBe("");
});
