import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import type {
	SessionKey,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import type { ConversationRuntimeRecord } from "@mymemo/agent-db/runtime-store";
import { agentSessions } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import {
	buildAgentSessionQueryConfig,
	conversationWorkingDirectory,
	createConversationSessionStore,
} from "./session-store";

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost — the
// agent_sessions dedup index would otherwise swallow the reused conv/session ids.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(agentSessions);
});

/** A main-transcript key for `conv-1`. projectKey is deliberately arbitrary —
 * the store binds to the conversation id, not the SDK-derived projectKey. */
function mainKey(sessionId = "sess-1", subpath?: string): SessionKey {
	return { projectKey: "whatever", sessionId, ...(subpath ? { subpath } : {}) };
}

function entry(uuid: string): SessionStoreEntry {
	return { type: "user", uuid };
}

describe("conversationWorkingDirectory", () => {
	it("is deterministic per conversation and distinct across conversations", () => {
		expect(conversationWorkingDirectory("conv-1")).toBe(
			conversationWorkingDirectory("conv-1"),
		);
		expect(conversationWorkingDirectory("conv-1")).not.toBe(
			conversationWorkingDirectory("conv-2"),
		);
	});
});

describe("createConversationSessionStore", () => {
	it("round-trips appended entries on load", async () => {
		const store = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
		});
		await store.append(mainKey(), [entry("a"), entry("b")]);

		expect(await store.load(mainKey())).toEqual([entry("a"), entry("b")]);
	});

	it("logs a bounded error identity while preserving the append failure", async () => {
		const databaseError = Object.assign(
			new Error("postgres connection detail"),
			{ name: "PostgresError", code: "ECONNRESET" },
		);
		const errors: Record<string, unknown>[] = [];
		const failingDb = {
			insert() {
				return {
					values() {
						return {
							async onConflictDoNothing() {
								throw databaseError;
							},
						};
					},
				};
			},
		} as unknown as Database;
		const store = createConversationSessionStore(failingDb, {
			conversationId: "conv-1",
			runId: "run-1",
			logger: {
				info() {},
				warn() {},
				error(fields) {
					errors.push(fields);
				},
			},
		});

		await expect(store.append(mainKey(), [entry("a")])).rejects.toBe(
			databaseError,
		);
		expect(errors).toEqual([
			{
				message: "agent session mirror append failed",
				runId: "run-1",
				conversationId: "conv-1",
				errorType: "PostgresError",
			},
		]);
		expect(JSON.stringify(errors)).not.toContain("postgres connection detail");
	});

	it("returns null for a session that was never written", async () => {
		const store = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
		});
		expect(await store.load(mainKey("unwritten"))).toBeNull();
	});

	it("scopes storage to the bound conversation", async () => {
		const store1 = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
		});
		const store2 = createConversationSessionStore(tdb.db, {
			conversationId: "conv-2",
		});
		await store1.append(mainKey(), [entry("only-conv-1")]);

		// Same session key, different conversation — must not see conv-1's entry.
		expect(await store2.load(mainKey())).toBeNull();
	});

	it("lists subagent subkeys and sessions", async () => {
		const store = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
		});
		await store.append(mainKey("sess-1"), [entry("main")]);
		await store.append(mainKey("sess-1", "subagents/agent-1"), [entry("sub")]);

		expect(
			await store.listSubkeys?.({ projectKey: "p", sessionId: "sess-1" }),
		).toEqual(["subagents/agent-1"]);
		const sessions = await store.listSessions?.("p");
		expect(sessions?.map((s) => s.sessionId)).toEqual(["sess-1"]);
	});

	it("deletes the named session", async () => {
		const store = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
		});
		await store.append(mainKey(), [entry("a")]);
		await store.delete?.(mainKey());

		expect(await store.load(mainKey())).toBeNull();
	});
});

describe("buildAgentSessionQueryConfig", () => {
	const base = { db: undefined as never, conversationId: "conv-1" };

	function runtime(agentSessionId: string | null): ConversationRuntimeRecord {
		return {
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: null,
			sandboxTainted: false,
			agentSessionId,
			createdAt: new Date(),
			updatedAt: new Date(),
		};
	}

	it("starts a fresh session (no resume) when there is no runtime row", () => {
		const config = buildAgentSessionQueryConfig({
			...base,
			db: tdb.db,
			runtime: null,
		});
		expect(config.resume).toBeUndefined();
		expect(config.cwd).toBe(conversationWorkingDirectory("conv-1"));
		expect(config.sessionStore).toBeDefined();
	});

	it("starts a fresh session when the pointer never advanced", () => {
		const config = buildAgentSessionQueryConfig({
			...base,
			db: tdb.db,
			runtime: runtime(null),
		});
		expect(config.resume).toBeUndefined();
	});

	it("resumes the stored session when the pointer is set", () => {
		const config = buildAgentSessionQueryConfig({
			...base,
			db: tdb.db,
			runtime: runtime("session-xyz"),
		});
		expect(config.resume).toBe("session-xyz");
	});
});
