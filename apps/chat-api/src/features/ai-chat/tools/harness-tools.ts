/**
 * Short names of the Harness user tools — the tools chat-api executes itself
 * on the AI SDK chat path. Empty until the first Harness tool lands.
 */
export const HARNESS_TOOL_NAMES = [] as const;

/** Claude Code built-ins enabled in the Harness sandbox, by adapter common name (ADR-0033 stage 2); every other built-in stays off. */
export const HARNESS_BUILTIN_TOOLS = ["read", "write", "edit", "grep"] as const;

/** Everything the per-turn `HarnessAgent` may call. */
export const HARNESS_ACTIVE_TOOLS = [
	...HARNESS_BUILTIN_TOOLS,
	...HARNESS_TOOL_NAMES,
];
