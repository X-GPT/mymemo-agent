import { describe, expect, it } from "bun:test";
import type { CanUseTool, SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "./agent";
import { MYMEMO_MCP_SERVER_NAME, SEARCH_DOCUMENTS_TOOL } from "./agent-tools";

const base = {
	userQuery: "hello",
	systemPrompt: "be helpful",
	cwd: "/workspace/conversations/c/work",
};

// A no-op store; buildQueryOptions only needs to forward the reference.
const fakeStore: SessionStore = {
	async append() {},
	async load() {
		return null;
	},
};

describe("buildQueryOptions", () => {
	it("forwards a sessionStore to query() when durable storage is configured", () => {
		const opts = buildQueryOptions({ ...base, sessionStore: fakeStore });
		expect(opts.sessionStore).toBe(fakeStore);
	});

	it("omits sessionStore when durable storage is not configured", () => {
		const opts = buildQueryOptions(base);
		expect("sessionStore" in opts).toBe(false);
	});

	it("never disables local writes (persistSession stays unset) with a store", () => {
		// The mirror hook fires after the local write; persistSession:false would
		// silence it. Guard against a regression that pairs them.
		const opts = buildQueryOptions({ ...base, sessionStore: fakeStore });
		expect("persistSession" in opts).toBe(false);
	});

	it("sets resume only when a prior sessionId is supplied", () => {
		expect(buildQueryOptions(base).resume).toBeUndefined();
		expect(buildQueryOptions({ ...base, sessionId: "sess-1" }).resume).toBe(
			"sess-1",
		);
	});
});

describe("buildQueryOptions tool surface", () => {
	it("pins the available built-ins to Bash plus the read-only working-set tools", () => {
		const opts = buildQueryOptions(base);
		expect(opts.tools).toEqual(["Bash", "Read", "Grep", "Glob"]);
	});

	it("pre-approves the built-ins plus the document tool via allowedTools", () => {
		const opts = buildQueryOptions(base);
		expect(opts.allowedTools).toEqual([
			"Bash",
			"Read",
			"Grep",
			"Glob",
			SEARCH_DOCUMENTS_TOOL,
		]);
	});

	it("does not rely on bypassPermissions and supplies a fail-closed canUseTool", async () => {
		const opts = buildQueryOptions(base);
		expect(opts.permissionMode).toBe("default");
		expect(opts.permissionMode).not.toBe("bypassPermissions");

		const canUse = opts.canUseTool as CanUseTool;
		const denied = await canUse("Write", {}, {} as never);
		expect(denied.behavior).toBe("deny");
		const allowed = await canUse("Bash", { command: "ls" }, {} as never);
		expect(allowed.behavior).toBe("allow");
	});

	it("registers the MyMemo MCP server so mcp__mymemo__search_documents is available", () => {
		const opts = buildQueryOptions(base);
		const servers = opts.mcpServers as Record<string, { name: string }>;
		expect(servers[MYMEMO_MCP_SERVER_NAME]).toBeDefined();
		expect(servers[MYMEMO_MCP_SERVER_NAME].name).toBe(MYMEMO_MCP_SERVER_NAME);
	});
});
