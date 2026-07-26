import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type {
	SessionKey,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { ConversationRuntimeRecord } from "@mymemo/agent-db/runtime-store";
import { agentSessions, conversations, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import type { WorkerLogger } from "../logger";
import {
	buildAgentSessionQueryConfig,
	conversationWorkingDirectory,
	createConversationSessionStore,
} from "./session-store";

let tdb: TestDb;
const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

function storeBinding(conversationId: string) {
	return {
		conversationId,
		runId: `run-${conversationId}`,
		workerId: "worker-1",
		logger: silentLogger,
	};
}

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost — the
// agent_sessions dedup index would otherwise swallow the reused conv/session ids.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

beforeEach(async () => {
	await tdb.db.insert(conversations).values([
		{ userId: "user-1", conversationId: "conv-1", scope: "general" },
		{ userId: "user-2", conversationId: "conv-2", scope: "general" },
	]);
	await tdb.db.insert(runs).values([
		{
			runId: "run-conv-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
			lockedBy: "worker-1",
			lockedUntil: new Date(Date.now() + 60_000),
		},
		{
			runId: "run-conv-2",
			userId: "user-2",
			conversationId: "conv-2",
			status: "running",
			lockedBy: "worker-1",
			lockedUntil: new Date(Date.now() + 60_000),
		},
	]);
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(agentSessions);
	await tdb.db.delete(runs);
	await tdb.db.delete(conversations);
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
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		await store.append(mainKey(), [entry("a"), entry("b")]);

		expect(await store.load(mainKey())).toEqual([entry("a"), entry("b")]);
	});

	it("logs a bounded error identity for a real database append failure", async () => {
		const errors: Record<string, unknown>[] = [];
		const store = createConversationSessionStore(tdb.db, {
			conversationId: "conv-1",
			runId: "run-conv-1",
			workerId: "worker-1",
			logger: {
				info() {},
				warn() {},
				error(fields) {
					errors.push(fields);
				},
			},
		});
		const invalidKey = {
			...mainKey(),
			projectKey: null,
		} as unknown as SessionKey;
		let databaseError: unknown;

		try {
			await store.append(invalidKey, [entry("private transcript detail")]);
		} catch (error) {
			databaseError = error;
		}

		expect(databaseError).toBeInstanceOf(Error);
		expect(errors).toEqual([
			{
				message: "agent session mirror append failed",
				runId: "run-conv-1",
				conversationId: "conv-1",
				errorType:
					databaseError instanceof Error
						? databaseError.name
						: typeof databaseError,
			},
		]);
		expect(JSON.stringify(errors)).not.toContain("private transcript detail");
	});

	it("returns null for a session that was never written", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		expect(await store.load(mainKey("unwritten"))).toBeNull();
	});

	it("scopes storage to the bound conversation", async () => {
		const store1 = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		const store2 = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-2"),
		);
		await store1.append(mainKey(), [entry("only-conv-1")]);

		// Same session key, different conversation — must not see conv-1's entry.
		expect(await store2.load(mainKey())).toBeNull();
	});

	it("lists subagent subkeys and sessions", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		await store.append(mainKey("sess-1"), [entry("main")]);
		await store.append(mainKey("sess-1", "subagents/agent-1"), [entry("sub")]);

		expect(
			await store.listSubkeys?.({ projectKey: "p", sessionId: "sess-1" }),
		).toEqual(["subagents/agent-1"]);
		const sessions = await store.listSessions?.("p");
		expect(sessions?.map((s) => s.sessionId)).toEqual(["sess-1"]);
	});

	it("deletes the named session", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		await store.append(mainKey(), [entry("a")]);
		await store.delete?.(mainKey());

		expect(await store.load(mainKey())).toBeNull();
	});

	it("rejects mutations when the bound worker does not own the Run", async () => {
		const store = createConversationSessionStore(tdb.db, {
			...storeBinding("conv-1"),
			workerId: "worker-stale",
		});

		await expect(store.append(mainKey(), [entry("rejected")])).rejects.toThrow(
			/session append.*rejected/i,
		);
		expect(await store.load(mainKey())).toBeNull();
	});

	it("records evidence only after a successful append to that main session", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);

		expect(store.mirroredMainSessionId()).toBeNull();
		await store.append(mainKey("sess-empty"), []);
		expect(store.mirroredMainSessionId()).toBeNull();
		await store.append(mainKey("sess-1", "subagents/agent-1"), [entry("sub")]);
		expect(store.mirroredMainSessionId()).toBeNull();
		await store.append(mainKey("sess-other"), [entry("other-main")]);
		expect(store.mirroredMainSessionId()).toBe("sess-other");
		await store.append(mainKey("sess-1"), [entry("main")]);
		expect(store.mirroredMainSessionId()).toBe("sess-1");
	});

	it("reports the most recently mirrored main session when a session repeats", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);

		await store.append(mainKey("sess-a"), [entry("a-1")]);
		await store.append(mainKey("sess-b"), [entry("b-1")]);
		await store.append(mainKey("sess-a"), [entry("a-2")]);

		expect(store.mirroredMainSessionId()).toBe("sess-a");
	});

	it("withdraws main-session evidence when the SDK deletes that session", async () => {
		const store = createConversationSessionStore(
			tdb.db,
			storeBinding("conv-1"),
		);
		await store.append(mainKey("sess-1"), [entry("main")]);
		expect(store.mirroredMainSessionId()).toBe("sess-1");

		await store.delete?.(mainKey("sess-1"));

		expect(store.mirroredMainSessionId()).toBeNull();
		expect(await store.load(mainKey("sess-1"))).toBeNull();
	});
});

describe("buildAgentSessionQueryConfig", () => {
	const base = {
		db: undefined as never,
		conversationId: "conv-1",
		runId: "run-conv-1",
		workerId: "worker-1",
		logger: silentLogger,
	};

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
