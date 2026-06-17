import { describe, expect, it } from "bun:test";
import {
	ALLOWED_BUILTIN_TOOLS,
	buildMymemoTools,
	createCanUseTool,
	createMymemoMcpServer,
	DISALLOWED_BUILTIN_TOOLS,
	MYMEMO_MCP_SERVER_NAME,
	PRE_APPROVED_TOOLS,
	SEARCH_DOCUMENTS_TOOL,
	SEARCH_DOCUMENTS_TOOL_NAME,
} from "./agent-tools";

// canUseTool's third arg (signal/suggestions/...) is unused by our handler.
const NO_OPTS = {} as never;

describe("tool surface constants", () => {
	it("exposes exactly one document operation, fully qualified as mcp__mymemo__*", () => {
		expect(SEARCH_DOCUMENTS_TOOL).toBe("mcp__mymemo__search_documents");
		expect(SEARCH_DOCUMENTS_TOOL).toBe(
			`mcp__${MYMEMO_MCP_SERVER_NAME}__${SEARCH_DOCUMENTS_TOOL_NAME}`,
		);
	});

	it("makes only the local working-set built-ins available, plus the document tool when pre-approved", () => {
		expect(ALLOWED_BUILTIN_TOOLS).toEqual(["Read", "Grep", "Glob"]);
		expect(PRE_APPROVED_TOOLS).toEqual([
			"Read",
			"Grep",
			"Glob",
			SEARCH_DOCUMENTS_TOOL,
		]);
	});

	it("keeps Bash off the available and pre-approved surface, and denies it explicitly", () => {
		expect(ALLOWED_BUILTIN_TOOLS).not.toContain("Bash");
		expect(PRE_APPROVED_TOOLS).not.toContain("Bash");
		expect(DISALLOWED_BUILTIN_TOOLS).toContain("Bash");
	});
});

describe("createCanUseTool (fail-closed permission handler)", () => {
	it("allows pre-approved built-ins and returns the original input unchanged", async () => {
		const canUse = createCanUseTool();
		const input = { file_path: "/workspace/conversations/c/work/a.md" };
		const res = await canUse("Read", input, NO_OPTS);
		expect(res.behavior).toBe("allow");
		if (res.behavior === "allow") {
			expect(res.updatedInput).toBe(input);
		}
	});

	it("allows the MyMemo document tool", async () => {
		const res = await createCanUseTool()(SEARCH_DOCUMENTS_TOOL, {}, NO_OPTS);
		expect(res.behavior).toBe("allow");
	});

	it("denies any tool that is not pre-approved, naming it in the message", async () => {
		const canUse = createCanUseTool();
		for (const denied of [
			"Bash",
			"Write",
			"Edit",
			"WebFetch",
			"WebSearch",
			"mcp__other__exfiltrate",
		]) {
			const res = await canUse(denied, {}, NO_OPTS);
			expect(res.behavior).toBe("deny");
			if (res.behavior === "deny") {
				expect(res.message).toContain(denied);
			}
		}
	});
});

describe("MyMemo MCP tool registration", () => {
	it("registers an sdk MCP server named 'mymemo' with a live instance", () => {
		const server = createMymemoMcpServer();
		expect(server.type).toBe("sdk");
		expect(server.name).toBe(MYMEMO_MCP_SERVER_NAME);
		expect(server.instance).toBeDefined();
	});

	it("defines the single search_documents tool", () => {
		const tools = buildMymemoTools();
		expect(tools.map((t) => t.name)).toEqual([SEARCH_DOCUMENTS_TOOL_NAME]);
	});

	it("returns a recoverable tool error until MYM-11 implements the handler", async () => {
		const [searchDocuments] = buildMymemoTools();
		const result = await searchDocuments.handler({}, undefined);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("not implemented");
	});
});

describe("no secrets on the tool surface", () => {
	// MYM-32: tool execution must not carry provider keys, DB credentials, or
	// broad document credentials. The surface we configure is data-only (tool
	// names, a deny message, a placeholder handler) — assert no secret-shaped
	// material leaks through it. The agent process env is scrubbed separately in
	// child-spawn.ts (and asserted by MYM-24's regression suite).
	it("never embeds secret-shaped values in the configured surface", () => {
		const surface = JSON.stringify({
			ALLOWED_BUILTIN_TOOLS,
			DISALLOWED_BUILTIN_TOOLS,
			PRE_APPROVED_TOOLS,
			SEARCH_DOCUMENTS_TOOL,
			tools: buildMymemoTools().map((t) => ({
				name: t.name,
				description: t.description,
			})),
		});
		for (const secret of [
			"ANTHROPIC_API_KEY",
			"DATABASE_URL",
			"LLM_TOKEN_SECRET",
			"DB_PASSWORD",
			"MYMEMO_DOC_TOKEN",
			"ANTHROPIC_AUTH_TOKEN",
			"sk-ant",
		]) {
			expect(surface).not.toContain(secret);
		}
	});

	it("the deny message does not echo tool input (which could contain secrets)", async () => {
		const res = await createCanUseTool()(
			"Bash",
			{ command: "echo $ANTHROPIC_API_KEY" },
			NO_OPTS,
		);
		expect(res.behavior).toBe("deny");
		if (res.behavior === "deny") {
			expect(res.message).not.toContain("ANTHROPIC_API_KEY");
			expect(res.message).not.toContain("echo");
		}
	});
});
