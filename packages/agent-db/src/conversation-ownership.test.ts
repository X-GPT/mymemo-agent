import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import {
	type ClaimedConversation,
	type ConversationOwner,
	claimConversationTx,
	conversationEpochExists,
	releaseConversationTx,
	renewConversationLeaseTx,
} from "./conversation-ownership";
import { conversations, runs } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

// One PGlite (WASM) instance for the whole file — a per-test instance
// multiplies WASM memory that is not reclaimed promptly and OOMs CI runners.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values([
		{ userId: "user-1", conversationId: "conv-1", scope: "general" },
		{ userId: "user-1", conversationId: "conv-2", scope: "general" },
	]);
});

/** Seed one Run with an explicit submission time and status. */
async function seedRun(input: {
	runId: string;
	conversationId: string;
	status?: string;
	createdAt?: Date;
}): Promise<void> {
	await tdb.db.insert(runs).values({
		runId: input.runId,
		userId: "user-1",
		conversationId: input.conversationId,
		status: input.status ?? "queued",
		...(input.createdAt ? { createdAt: input.createdAt } : {}),
	});
}

/** Unwrap a Claim the test expects to have been taken. */
function claimed(claim: ClaimedConversation | null): ClaimedConversation {
	if (!claim) throw new Error("expected a Claim, got none");
	return claim;
}

async function readOwnership(conversationId: string) {
	const [row] = await tdb.db
		.select({
			ownerWorkerId: conversations.ownerWorkerId,
			ownerUntil: conversations.ownerUntil,
			epoch: conversations.epoch,
		})
		.from(conversations)
		.where(
			and(
				eq(conversations.userId, "user-1"),
				eq(conversations.conversationId, conversationId),
			),
		);
	if (!row) throw new Error(`conversation ${conversationId} vanished`);
	return row;
}

/** Force a lease to have lapsed without waiting out its real duration. */
async function lapseLease(conversationId: string): Promise<void> {
	await tdb.db
		.update(conversations)
		.set({ ownerUntil: sql`now() - interval '1 second'` })
		.where(
			and(
				eq(conversations.userId, "user-1"),
				eq(conversations.conversationId, conversationId),
			),
		);
}

/**
 * Evaluate the epoch fence exactly as a fenced write does: as a predicate
 * ANDed into a statement over another table.
 */
async function fenceAdmits(
	owner: ConversationOwner,
	runId: string,
): Promise<boolean> {
	const rows = await tdb.db
		.select({ runId: runs.runId })
		.from(runs)
		.where(and(eq(runs.runId, runId), conversationEpochExists(owner)));
	return rows.length > 0;
}

describe("claimConversationTx", () => {
	it("takes a Conversation with a queued Run, and reports its identity, epoch, and deadline", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const before = Date.now();

		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);

		expect(claim.userId).toBe("user-1");
		expect(claim.conversationId).toBe("conv-1");
		expect(claim.epoch).toBe(1);
		expect(claim.ownerUntil.getTime()).toBeGreaterThan(before);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-1",
			epoch: 1,
		});
	});

	it("returns null when no Conversation has a queued Run", async () => {
		await seedRun({
			runId: "run-done",
			conversationId: "conv-1",
			status: "done",
		});
		await seedRun({
			runId: "run-running",
			conversationId: "conv-2",
			status: "running",
		});

		expect(await claimConversationTx(tdb.db, { workerId: "worker-1" })).toBe(
			null,
		);
	});

	it("leaves a Conversation already under a live lease to its owner", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });

		const first = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		const second = await claimConversationTx(tdb.db, { workerId: "worker-2" });

		expect(second).toBe(null);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-1",
			epoch: first.epoch,
		});
	});

	it("claims a Conversation whose lease lapsed, superseding the old epoch", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const lapsed = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");

		const successor = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-2" }),
		);

		expect(successor.epoch).toBe(lapsed.epoch + 1);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-2",
		});
	});

	it("takes the Conversation whose queued Run was submitted first", async () => {
		await seedRun({
			runId: "run-newer",
			conversationId: "conv-1",
			createdAt: new Date("2026-07-29T10:00:01Z"),
		});
		await seedRun({
			runId: "run-older",
			conversationId: "conv-2",
			createdAt: new Date("2026-07-29T10:00:00Z"),
		});

		const first = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		const second = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-2" }),
		);

		expect(first.conversationId).toBe("conv-2");
		expect(second.conversationId).toBe("conv-1");
	});
});

describe("the Claim's snapshot", () => {
	// A Conversation cannot yet hold more than one queued Run: the
	// `runs_one_active_per_conversation` partial unique index still bounds it to
	// one Active Run. So the snapshot's `created_at` ordering has no multi-Run
	// case to exercise here — it first becomes reachable when admission enforces
	// the Active Run bound explicitly and that index is dropped, which is where
	// the ordering assertion belongs. What is exercisable now is which Runs the
	// snapshot selects; the Claim's own candidate ordering, covered above,
	// already evaluates the same `created_at` key.

	it("holds the Conversation's queued Runs and nothing else", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		await seedRun({
			runId: "run-terminal",
			conversationId: "conv-1",
			status: "done",
		});
		await seedRun({ runId: "run-other-conv", conversationId: "conv-2" });

		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);

		expect(claim.runIds).toEqual(["run-1"]);
	});

	it("leaves a Run submitted after the Claim to a later Claim", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);

		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: sql`now()` })
			.where(eq(runs.runId, "run-1"));
		await seedRun({ runId: "run-2", conversationId: "conv-1" });

		expect(claim.runIds).toEqual(["run-1"]);
	});
});

describe("releaseConversationTx", () => {
	it("clears the lease so the Conversation is claimable again", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);

		expect(await releaseConversationTx(tdb.db, claim)).toBe(true);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
			epoch: claim.epoch,
		});
		expect(
			claimed(await claimConversationTx(tdb.db, { workerId: "worker-2" }))
				.conversationId,
		).toBe("conv-1");
	});

	it("cannot take the Conversation back from a successor", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const superseded = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");
		const successor = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-2" }),
		);

		expect(await releaseConversationTx(tdb.db, superseded)).toBe(false);
		expect(await readOwnership("conv-1")).toMatchObject({
			ownerWorkerId: "worker-2",
			epoch: successor.epoch,
		});
	});

	it("reports nothing released for an unowned Conversation", async () => {
		expect(
			await releaseConversationTx(tdb.db, {
				userId: "user-1",
				conversationId: "conv-1",
				epoch: 7,
			}),
		).toBe(false);
	});
});

describe("renewConversationLeaseTx", () => {
	it("pushes the deadline forward", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await tdb.db
			.update(conversations)
			.set({ ownerUntil: sql`now() + interval '1 second'` })
			.where(eq(conversations.conversationId, "conv-1"));

		const renewed = await renewConversationLeaseTx(tdb.db, claim);

		expect(renewed).not.toBe(null);
		expect(renewed?.getTime()).toBeGreaterThan(Date.now() + 30_000);
	});

	it("reports a lost lease once a successor superseded the epoch", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const superseded = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");
		await claimConversationTx(tdb.db, { workerId: "worker-2" });

		expect(await renewConversationLeaseTx(tdb.db, superseded)).toBe(null);
	});

	it("reports a lost lease once the deadline lapsed with no successor", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");

		expect(await renewConversationLeaseTx(tdb.db, claim)).toBe(null);
	});
});

describe("conversationEpochExists", () => {
	it("admits the Claim that holds the live lease", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);

		expect(await fenceAdmits(claim, "run-1")).toBe(true);
	});

	it("refuses a Claim a re-Claim superseded", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const superseded = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");
		const successor = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-2" }),
		);

		expect(await fenceAdmits(superseded, "run-1")).toBe(false);
		expect(await fenceAdmits(successor, "run-1")).toBe(true);
	});

	it("refuses a lease that merely lapsed, with no successor", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await lapseLease("conv-1");

		expect(await fenceAdmits(claim, "run-1")).toBe(false);
	});

	it("refuses a released Claim", async () => {
		await seedRun({ runId: "run-1", conversationId: "conv-1" });
		const claim = claimed(
			await claimConversationTx(tdb.db, { workerId: "worker-1" }),
		);
		await releaseConversationTx(tdb.db, claim);

		expect(await fenceAdmits(claim, "run-1")).toBe(false);
	});
});
