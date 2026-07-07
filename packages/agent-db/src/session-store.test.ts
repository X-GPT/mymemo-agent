import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { agentSessions } from "./schema";
import {
	type AgentSessionEntry,
	appendAgentSessionEntriesTx,
	deleteAgentSessionTx,
	deleteConversationAgentSessionsTx,
	listAgentSessionSubkeysTx,
	listAgentSessionsTx,
	loadAgentSessionEntriesTx,
} from "./session-store";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

// One PGlite instance for the whole file; tables cleared between tests.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(agentSessions);
});

/** The main-transcript ref every test shares unless it needs a subagent. */
const MAIN = {
	conversationId: "conv-1",
	projectKey: "project-conv-1",
	sessionId: "sess-1",
};

/** A minimal transcript entry; extra fields ride along in the jsonb blob. */
function entry(
	uuid: string | undefined,
	extra: Record<string, unknown> = {},
): AgentSessionEntry {
	return { type: "user", ...(uuid ? { uuid } : {}), ...extra };
}

describe("appendAgentSessionEntriesTx + loadAgentSessionEntriesTx", () => {
	it("round-trips entries in append order", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [
			entry("a", { n: 1 }),
			entry("b", { n: 2 }),
		]);
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("c", { n: 3 })]);

		const loaded = await loadAgentSessionEntriesTx(tdb.db, MAIN);
		expect(loaded).toEqual([
			entry("a", { n: 1 }),
			entry("b", { n: 2 }),
			entry("c", { n: 3 }),
		]);
	});

	it("returns null for a transcript that was never written", async () => {
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				...MAIN,
				sessionId: "never",
			}),
		).toBeNull();
	});

	it("deduplicates by entry uuid so a re-delivered batch does not double-insert", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("a"), entry("b")]);
		// The SDK's at-most-once mirror re-delivers: `a` repeats, `c` is new.
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("a"), entry("c")]);

		const loaded = await loadAgentSessionEntriesTx(tdb.db, MAIN);
		expect(loaded?.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
	});

	it("keeps every uuid-less entry (NULL uuids are distinct, so cannot dedup)", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry(undefined)]);
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry(undefined)]);

		const loaded = await loadAgentSessionEntriesTx(tdb.db, MAIN);
		expect(loaded).toHaveLength(2);
	});

	it("isolates transcripts by conversation and by subpath", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("main")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, subpath: "subagents/agent-1" },
			[entry("sub")],
		);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, conversationId: "conv-2", projectKey: "project-conv-2" },
			[entry("other")],
		);

		expect(
			(await loadAgentSessionEntriesTx(tdb.db, MAIN))?.map((e) => e.uuid),
		).toEqual(["main"]);
		expect(
			(
				await loadAgentSessionEntriesTx(tdb.db, {
					...MAIN,
					subpath: "subagents/agent-1",
				})
			)?.map((e) => e.uuid),
		).toEqual(["sub"]);
	});

	it("no-ops on an empty batch", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, []);
		expect(await loadAgentSessionEntriesTx(tdb.db, MAIN)).toBeNull();
	});
});

describe("listAgentSessionsTx", () => {
	it("lists distinct sessions for a conversation with a numeric mtime", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("a")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, sessionId: "sess-2" },
			[entry("b")],
		);

		const sessions = await listAgentSessionsTx(tdb.db, {
			conversationId: MAIN.conversationId,
		});
		expect(sessions.map((s) => s.sessionId).sort()).toEqual([
			"sess-1",
			"sess-2",
		]);
		for (const s of sessions) expect(Number.isFinite(s.mtime)).toBe(true);
	});

	it("does not leak sessions from another conversation", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("a")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-2", projectKey: "p2", sessionId: "sess-x" },
			[entry("b")],
		);

		const sessions = await listAgentSessionsTx(tdb.db, {
			conversationId: MAIN.conversationId,
		});
		expect(sessions.map((s) => s.sessionId)).toEqual(["sess-1"]);
	});
});

describe("listAgentSessionSubkeysTx", () => {
	it("returns the non-empty subpaths under a session", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("main")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, subpath: "subagents/agent-1" },
			[entry("s1")],
		);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, subpath: "subagents/agent-2" },
			[entry("s2")],
		);

		const subkeys = await listAgentSessionSubkeysTx(tdb.db, {
			conversationId: MAIN.conversationId,
			sessionId: MAIN.sessionId,
		});
		expect(subkeys.sort()).toEqual(["subagents/agent-1", "subagents/agent-2"]);
	});

	it("returns an empty list for a session with only a main transcript", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("main")]);
		expect(
			await listAgentSessionSubkeysTx(tdb.db, {
				conversationId: MAIN.conversationId,
				sessionId: MAIN.sessionId,
			}),
		).toEqual([]);
	});
});

describe("deleteAgentSessionTx", () => {
	it("deletes a whole session (main + subagents) when no subpath is given", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("main")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, subpath: "subagents/agent-1" },
			[entry("sub")],
		);

		await deleteAgentSessionTx(tdb.db, {
			conversationId: MAIN.conversationId,
			sessionId: MAIN.sessionId,
		});

		expect(await loadAgentSessionEntriesTx(tdb.db, MAIN)).toBeNull();
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				...MAIN,
				subpath: "subagents/agent-1",
			}),
		).toBeNull();
	});

	it("deletes only the named subpath when one is given", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("main")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, subpath: "subagents/agent-1" },
			[entry("sub")],
		);

		await deleteAgentSessionTx(tdb.db, {
			conversationId: MAIN.conversationId,
			sessionId: MAIN.sessionId,
			subpath: "subagents/agent-1",
		});

		expect(
			(await loadAgentSessionEntriesTx(tdb.db, MAIN))?.map((e) => e.uuid),
		).toEqual(["main"]);
		expect(
			await loadAgentSessionEntriesTx(tdb.db, {
				...MAIN,
				subpath: "subagents/agent-1",
			}),
		).toBeNull();
	});
});

describe("deleteConversationAgentSessionsTx", () => {
	it("deletes every transcript for the conversation and leaves others intact", async () => {
		await appendAgentSessionEntriesTx(tdb.db, MAIN, [entry("a")]);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ ...MAIN, sessionId: "sess-2", subpath: "subagents/agent-1" },
			[entry("b")],
		);
		await appendAgentSessionEntriesTx(
			tdb.db,
			{ conversationId: "conv-2", projectKey: "p2", sessionId: "sess-x" },
			[entry("keep")],
		);

		await deleteConversationAgentSessionsTx(tdb.db, {
			conversationId: MAIN.conversationId,
		});

		expect(
			await listAgentSessionsTx(tdb.db, {
				conversationId: MAIN.conversationId,
			}),
		).toEqual([]);
		expect(
			(
				await loadAgentSessionEntriesTx(tdb.db, {
					conversationId: "conv-2",
					projectKey: "p2",
					sessionId: "sess-x",
				})
			)?.map((e) => e.uuid),
		).toEqual(["keep"]);
	});
});
