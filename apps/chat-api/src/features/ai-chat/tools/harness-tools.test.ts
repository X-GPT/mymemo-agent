import { expect, it } from "bun:test";
import {
	HARNESS_ACTIVE_TOOLS,
	HARNESS_BUILTIN_TOOLS,
	HARNESS_TOOL_NAMES,
} from "./harness-tools";

it("activates exactly Read, Write, Edit, and Grep plus the Harness user tools", () => {
	expect(HARNESS_BUILTIN_TOOLS).toEqual(["read", "write", "edit", "grep"]);
	expect(HARNESS_ACTIVE_TOOLS).toEqual([
		"read",
		"write",
		"edit",
		"grep",
		...HARNESS_TOOL_NAMES,
	]);
});
