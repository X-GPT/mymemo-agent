import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { agentSessions, conversations, runs } from "./schema";
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
	await tdb.db.delete(runs);
	await tdb.db.delete(conversations);
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

function ownerFor(conversationId: string) {
	return {
		conversationId,
		runId: `run-${conversationId}`,
		workerId: "worker-1",
	};
}

async function appendEntries(
	ref: Parameters<typeof loadAgentSessionEntriesTx>[1],
	entries: AgentSessionEntry[],
): Promise<void> {
	const { conversationId, ...session } = ref;
	await appendAgentSessionEntriesTx(tdb.db, {
		owner: ownerFor(conversationId),
		ref: session,
		entries,
	});
}

async function deleteSession(input: {
	conversationId: string;
	sessionId: string;
	subpath?: string;
}): Promise<void> {
	const { conversationId, ...session } = input;
	await deleteAgentSessionTx(tdb.db, {
		owner: ownerFor(conversationId),
		ref: session,
	});
}

describe("appendAgentSessionEntriesTx + loadAgentSessionEntriesTx", () => {
	it("round-trips entries in append order", async () => {
		await appendEntries(MAIN, [entry("a", { n: 1 }), entry("b", { n: 2 })]);
		await appendEntries(MAIN, [entry("c", { n: 3 })]);

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
		await appendEntries(MAIN, [entry("a"), entry("b")]);
		// The SDK's at-most-once mirror re-delivers: `a` repeats, `c` is new.
		await appendEntries(MAIN, [entry("a"), entry("c")]);

		const loaded = await loadAgentSessionEntriesTx(tdb.db, MAIN);
		expect(loaded?.map((e) => e.uuid)).toEqual(["a", "b", "c"]);
	});

	it("keeps every uuid-less entry (NULL uuids are distinct, so cannot dedup)", async () => {
		await appendEntries(MAIN, [entry(undefined)]);
		await appendEntries(MAIN, [entry(undefined)]);

		const loaded = await loadAgentSessionEntriesTx(tdb.db, MAIN);
		expect(loaded).toHaveLength(2);
	});

	it("isolates transcripts by conversation and by subpath", async () => {
		await appendEntries(MAIN, [entry("main")]);
		await appendEntries({ ...MAIN, subpath: "subagents/agent-1" }, [
			entry("sub"),
		]);
		await appendEntries(
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
		await appendEntries(MAIN, []);
		expect(await loadAgentSessionEntriesTx(tdb.db, MAIN)).toBeNull();
	});
});

describe("listAgentSessionsTx", () => {
	it("lists distinct sessions for a conversation with a numeric mtime", async () => {
		await appendEntries(MAIN, [entry("a")]);
		await appendEntries({ ...MAIN, sessionId: "sess-2" }, [entry("b")]);

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
		await appendEntries(MAIN, [entry("a")]);
		await appendEntries(
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
		await appendEntries(MAIN, [entry("main")]);
		await appendEntries({ ...MAIN, subpath: "subagents/agent-1" }, [
			entry("s1"),
		]);
		await appendEntries({ ...MAIN, subpath: "subagents/agent-2" }, [
			entry("s2"),
		]);

		const subkeys = await listAgentSessionSubkeysTx(tdb.db, {
			conversationId: MAIN.conversationId,
			sessionId: MAIN.sessionId,
		});
		expect(subkeys.sort()).toEqual(["subagents/agent-1", "subagents/agent-2"]);
	});

	it("returns an empty list for a session with only a main transcript", async () => {
		await appendEntries(MAIN, [entry("main")]);
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
		await appendEntries(MAIN, [entry("main")]);
		await appendEntries({ ...MAIN, subpath: "subagents/agent-1" }, [
			entry("sub"),
		]);

		await deleteSession({
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
		await appendEntries(MAIN, [entry("main")]);
		await appendEntries({ ...MAIN, subpath: "subagents/agent-1" }, [
			entry("sub"),
		]);

		await deleteSession({
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
		await appendEntries(MAIN, [entry("a")]);
		await appendEntries(
			{ ...MAIN, sessionId: "sess-2", subpath: "subagents/agent-1" },
			[entry("b")],
		);
		await appendEntries(
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

describe("SDK session mutation ownership fence", () => {
	const OWNER = {
		conversationId: "conv-owned",
		runId: "run-owned",
		workerId: "worker-owned",
	};
	const REF = {
		projectKey: "project-owned",
		sessionId: "session-owned",
	};
	const READ_REF = { conversationId: OWNER.conversationId, ...REF };

	async function insertOwnedRun(input: {
		conversationId?: string;
		status?: "running" | "interrupt_requested" | "done";
		workerId?: string;
		expired?: boolean;
	}) {
		const conversationId = input.conversationId ?? OWNER.conversationId;
		await tdb.db
			.insert(conversations)
			.values({ userId: "user-owned", conversationId, scope: "general" })
			.onConflictDoNothing();
		await tdb.db.insert(runs).values({
			runId: OWNER.runId,
			userId: "user-owned",
			conversationId,
			status: input.status ?? "running",
			lockedBy: input.workerId ?? OWNER.workerId,
			lockedUntil: input.expired
				? new Date(Date.now() - 1_000)
				: new Date(Date.now() + 60_000),
		});
	}

	it.each([
		"running",
		"interrupt_requested",
	] as const)("allows the matching owner to append while the Run is %s", async (status) => {
		await insertOwnedRun({ status });

		await appendAgentSessionEntriesTx(tdb.db, {
			owner: OWNER,
			ref: REF,
			entries: [entry(status)],
		});

		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toEqual([
			entry(status),
		]);
	});

	it.each([
		["a different Conversation", { conversationId: "conv-other" }],
		["a different worker", { workerId: "worker-stale" }],
		["an expired lease", { expired: true }],
		["a terminal Run", { status: "done" as const }],
	])("rejects mutations under %s without effect", async (_name, run) => {
		await insertOwnedRun(run);
		await tdb.db.insert(agentSessions).values({
			conversationId: OWNER.conversationId,
			...REF,
			subpath: "",
			uuid: "accepted",
			entry: entry("accepted"),
		});

		await expect(
			appendAgentSessionEntriesTx(tdb.db, {
				owner: OWNER,
				ref: REF,
				entries: [entry("rejected")],
			}),
		).rejects.toThrow(/session append.*rejected/i);
		await expect(
			deleteAgentSessionTx(tdb.db, {
				owner: OWNER,
				ref: {
					sessionId: REF.sessionId,
				},
			}),
		).rejects.toThrow(/session delete.*rejected/i);
		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toEqual([
			entry("accepted"),
		]);
	});

	it("treats an empty append as a pure no-op", async () => {
		await insertOwnedRun({});

		await expect(
			appendAgentSessionEntriesTx(tdb.db, {
				owner: { ...OWNER, runId: "run-other" },
				ref: REF,
				entries: [],
			}),
		).resolves.toBeUndefined();
		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toBeNull();
	});

	it("rejects append bound to a different Run id without effect", async () => {
		await insertOwnedRun({});

		await expect(
			appendAgentSessionEntriesTx(tdb.db, {
				owner: { ...OWNER, runId: "run-other" },
				ref: REF,
				entries: [entry("rejected")],
			}),
		).rejects.toThrow(/session append.*rejected/i);
		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toBeNull();
	});

	it("rejects delete bound to a different Run id without effect", async () => {
		await insertOwnedRun({});
		await appendAgentSessionEntriesTx(tdb.db, {
			owner: OWNER,
			ref: REF,
			entries: [entry("accepted")],
		});

		await expect(
			deleteAgentSessionTx(tdb.db, {
				owner: { ...OWNER, runId: "run-other" },
				ref: {
					sessionId: REF.sessionId,
				},
			}),
		).rejects.toThrow(/session delete.*rejected/i);
		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toEqual([
			entry("accepted"),
		]);
	});

	it("allows the matching owner to delete an SDK session", async () => {
		await insertOwnedRun({});
		await appendAgentSessionEntriesTx(tdb.db, {
			owner: OWNER,
			ref: REF,
			entries: [entry("accepted")],
		});

		await deleteAgentSessionTx(tdb.db, {
			owner: OWNER,
			ref: {
				sessionId: REF.sessionId,
			},
		});
		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toBeNull();
	});

	it("keeps Conversation-deletion cleanup administratively authorized", async () => {
		await tdb.db.insert(agentSessions).values({
			conversationId: OWNER.conversationId,
			...REF,
			subpath: "",
			uuid: "cleanup",
			entry: entry("cleanup"),
		});

		await deleteConversationAgentSessionsTx(tdb.db, {
			conversationId: OWNER.conversationId,
		});

		expect(await loadAgentSessionEntriesTx(tdb.db, READ_REF)).toBeNull();
	});
});
