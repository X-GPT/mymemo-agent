/**
 * Short names of the Harness user tools — the tools chat-api executes itself
 * on the AI SDK chat path. Empty until the first Harness tool lands.
 */
export const HARNESS_TOOL_NAMES = [] as const;

/**
 * The Claude Code built-ins re-enabled inside the Harness sandbox, by the
 * adapter's common names (ADR-0033 stage 2 revision). Every other built-in —
 * `bash`, `glob`, `webSearch`, and the natives the adapter does not model —
 * stays off because it is absent from this list.
 */
export const HARNESS_BUILTIN_TOOLS = ["read", "write", "edit", "grep"] as const;

/**
 * Exactly what the per-turn `HarnessAgent` may call: the four built-ins plus
 * the Harness user tools. A new tool is enabled by adding its name to one of
 * the two lists above; nothing else is ever active.
 */
export const HARNESS_ACTIVE_TOOLS = [
	...HARNESS_BUILTIN_TOOLS,
	...HARNESS_TOOL_NAMES,
];
