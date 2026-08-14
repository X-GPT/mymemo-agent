import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { and, eq, inArray, sql } from "drizzle-orm";
import { createDatabase, type Database, type DbTx } from "./client";
import {
	type ClaimedConversation,
	type ConversationOwner,
	claimConversationTx,
	liveConversationOwnershipExists,
	releaseConversationTx,
	renewConversationLeaseTx,
} from "./conversation-ownership";
import {
	admitQueuedRunTx,
	expireUnownedQueuedRunsTx,
	reclaimConversationTx,
} from "./run-store";
import { conversations, runs } from "./schema";

/**
 * The Claim and Reclamation protocol's concurrency properties (ADR-0015), against real
 * PostgreSQL.
 *
 * These are the properties Conversation-level ownership rests on, and they are
 * exactly the ones this package's PGlite harness structurally cannot express: a
 * single in-process backend has no second session to contend with, so
 * `SKIP LOCKED`, the Claim-versus-admission snapshot boundary, and a superseded
 * holder racing its successor are all unobservable there. Everything one backend
 * *can* express stays in `conversation-ownership.test.ts` — this file adds only
 * what needs two.
 *
 * Assertions sit on what a caller can observe: which claimant got the
 * Conversation, which Runs a snapshot contains, which write was refused. Never
 * on epoch values, SQL text, or plan shape. The Claim's plan is verified once by
 * hand on the production major as a cutover pre-flight step, deliberately not
 * here, because an `EXPLAIN` assertion fails for planner and statistics changes
 * that are not regressions.
 *
 * Gated on `AGENT_DATABASE_URL` — the same variable the existing integration
 * lane uses — and invoked by that lane's CI job, so with no database configured
 * the package's suite runs exactly as it did before. Locally:
 *
 *   bun run --cwd apps/chat-api db:migrate
 *   AGENT_DATABASE_URL=postgres://… bun test \
 *     packages/agent-db/src/conversation-ownership.postgres.test.ts
 *
 * That Postgres must run the major production runs, or a pass here is not
 * evidence about production; `compose.yaml` and the CI service both pin it.
 */

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";

/** Owner of every row this file writes, so cleanup never touches anything else. */
const USER_ID = `ownership-${crypto.randomUUID()}`;

/**
 * How long a statement that must not block is given before the test calls it
 * blocked. Deliberately far past anything healthy rather than tuned to it: what
 * this catches is a statement waiting on a lock nothing will release until the
 * test does, so the bound only has to exceed a slow runner, never approximate a
 * fast one.
 */
const NON_BLOCKING_MS = 10_000;

/**
 * Submission times are pinned into the past, and far enough back that these Runs
 * sort ahead of anything a shared local database happens to hold. The Claim
 * takes the globally oldest queued Run's Conversation, so without this a
 * leftover elsewhere in the database would decide which Conversation a claimant
 * gets and every assertion below would be about the wrong row.
 */
const FIRST_SUBMISSION_MS = Date.parse("2000-01-01T00:00:00Z");

// Raised off bun's 5s default only when the suite will actually run, and raised
// past {@link NON_BLOCKING_MS} so a statement that blocks is reported as blocked
// rather than as a test that ran out of time. Must be module scope: by the time
// a hook runs, the tests have already been registered with their timeouts.
if (RUN) setDefaultTimeout(30_000);

let db: Database;

/** `runs.run_id` is a global primary key, so Run ids carry the owner. */
function ownedRunId(name: string): string {
	return `${USER_ID}/${name}`;
}

function submittedAt(order: number): Date {
	return new Date(FIRST_SUBMISSION_MS + order * 1_000);
}

function conversationKey(conversationId: string) {
	return and(
		eq(conversations.userId, USER_ID),
		eq(conversations.conversationId, conversationId),
	);
}

async function seedConversations(...conversationIds: string[]): Promise<void> {
	await db.insert(conversations).values(
		conversationIds.map((conversationId) => ({
			userId: USER_ID,
			conversationId,
			scope: "general",
		})),
	);
}

/** A queued Run to seed: its name, its Conversation, and its place in the queue. */
interface SeededRun {
	runId: string;
	conversationId: string;
	order: number;
}

/** The row an admission commits, without the admission path's other writes. */
function queuedRunValues(input: SeededRun) {
	return {
		runId: ownedRunId(input.runId),
		userId: USER_ID,
		conversationId: input.conversationId,
		status: "queued",
		createdAt: submittedAt(input.order),
	};
}

async function seedRun(input: SeededRun): Promise<void> {
	await db.insert(runs).values(queuedRunValues(input));
}

/** Every row this file wrote, and nothing else — Runs and their events cascade. */
async function deleteOwnRows(): Promise<void> {
	await db.delete(conversations).where(eq(conversations.userId, USER_ID));
}

/** Admission's first act: the Conversation row lock its Active Run bound rests on. */
async function lockConversationRow(
	tx: DbTx,
	conversationId: string,
): Promise<void> {
	await tx
		.select({ conversationId: conversations.conversationId })
		.from(conversations)
		.where(conversationKey(conversationId))
		.for("update");
}

/** Unwrap a Claim the test expects to have been taken. */
function claimed(
	claim: ClaimedConversation | null | undefined,
): ClaimedConversation {
	if (!claim) throw new Error("expected a Claim, got none");
	return claim;
}

/** Claim and serve until nothing is claimable, returning every Run served. */
async function drainAll(): Promise<string[]> {
	const served: string[] = [];
	for (;;) {
		const claim = await claimConversationTx(db, { workerId: "drain" });
		if (!claim) return served;
		served.push(...(await drain(claim)));
	}
}

/** Serve a Claim's snapshot to Outcomes and release it, as the drain will. */
async function drain(claim: ClaimedConversation): Promise<string[]> {
	if (claim.userId !== USER_ID) {
		// The Claim is global, so a Conversation this file does not own can be
		// handed to it. Release it and stop rather than terminalize somebody else's
		// Runs: that keeps "this suite never writes outside its own rows" a
		// property of the code instead of a precondition the pre-flight and the CI
		// step order have to maintain between them.
		await releaseConversationTx(db, claim);
		throw new Error(
			`Claim landed on the foreign Conversation ${claim.conversationId}; ` +
				"the database gained queued work this suite does not own",
		);
	}
	if (claim.runIds.length === 0) {
		// A Claim is only granted for a Conversation with a queued Run, and the
		// snapshot shares that transaction, so an empty one means the Claim took a
		// Conversation it will serve nothing for. Reported rather than left to spin
		// {@link drainAll} forever.
		throw new Error(
			`Claim of ${claim.conversationId} served an empty snapshot`,
		);
	}
	// A raw terminal write because this Claim-protocol suite does not exercise the
	// Run transition helpers. Reaching an Outcome is only what lets the next Claim
	// proceed here; terminalization is not under test.
	await db
		.update(runs)
		.set({ status: "done", terminalAt: sql`now()` })
		.where(inArray(runs.runId, claim.runIds));
	await releaseConversationTx(db, claim);
	return claim.runIds;
}

/** One Conversation, one queued Run, and the two Claims that raced for it. */
async function supersede(): Promise<{
	superseded: ClaimedConversation;
	successor: ClaimedConversation;
}> {
	await seedConversations("conv-a");
	await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });
	const superseded = claimed(
		await claimConversationTx(db, { workerId: "worker-1" }),
	);
	await db
		.update(runs)
		.set({ status: "running" })
		.where(eq(runs.runId, ownedRunId("a")));
	await lapseLease("conv-a");
	const reclamation = await reclaimConversationTx(db);
	if (reclamation?.conversationId !== "conv-a") {
		throw new Error("test setup failed to reclaim conv-a");
	}
	await seedRun({ runId: "successor", conversationId: "conv-a", order: 1 });
	const successor = claimed(
		await claimConversationTx(db, { workerId: "worker-2" }),
	);
	return { superseded, successor };
}

/** Force a lease to have lapsed without waiting out its real duration. */
async function lapseLease(conversationId: string): Promise<void> {
	await db
		.update(conversations)
		.set({ ownerUntil: sql`now() - interval '1 second'` })
		.where(conversationKey(conversationId));
}

/**
 * The shape a fenced write carries: the statement's own predicate ANDed with the
 * Ownership fence, so a refused write is zero rows rather than an error. It
 * stamps the executing worker onto the Run, like the queued→running transition,
 * which makes "whose write landed" readable off the Run afterwards.
 */
async function fencedStamp(
	owner: ConversationOwner,
	workerId: string,
	runName: string,
): Promise<boolean> {
	const stamped = await db
		.update(runs)
		.set({ executedByWorkerId: workerId })
		.where(
			and(
				eq(runs.runId, ownedRunId(runName)),
				liveConversationOwnershipExists(owner),
			),
		)
		.returning({ runId: runs.runId });
	return stamped.length > 0;
}

/**
 * Run an operation while a second, uncommitted transaction holds whatever
 * `prelude` took — the only way to put a genuinely concurrent session into a
 * known state. A blocked operation is reported rather than left to hang until
 * the runner's timeout, since blocking is the defect these tests exist to catch.
 * The held transaction always ends, so neither a blocked operation nor a failing
 * prelude can leave a lock behind for the rest of the file.
 */
async function operateWhileHeld<T>(
	prelude: (tx: DbTx) => Promise<void>,
	operation: () => Promise<T>,
	operationName: string,
): Promise<T> {
	const opened = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const held = db.transaction(async (tx) => {
		await prelude(tx);
		opened.resolve();
		await release.promise;
	});
	// A prelude that throws must fail the test rather than hang it waiting to be
	// told the transaction is open. Attaching the handler also keeps the eventual
	// rejection from surfacing as an unhandled one; `await held` below rethrows it.
	held.catch((err) => opened.reject(err));
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await opened.promise;
		return await Promise.race([
			operation(),
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() =>
						reject(
							new Error(
								`${operationName} blocked for over ${NON_BLOCKING_MS}ms`,
							),
						),
					NON_BLOCKING_MS,
				);
			}),
		]);
	} finally {
		clearTimeout(timer);
		release.resolve();
		await held;
	}
}

async function claimWhileHeld(
	prelude: (tx: DbTx) => Promise<void>,
	workerId: string,
): Promise<ClaimedConversation | null> {
	return await operateWhileHeld(
		prelude,
		() => claimConversationTx(db, { workerId }),
		"the Claim",
	);
}

describe.skipIf(!RUN)("the Claim protocol against real Postgres", () => {
	beforeAll(async () => {
		db = createDatabase(DB_URL);

		// The Claim is global — it takes the oldest claimable Conversation in the
		// database, not one this file owns. Pinned submission times keep these Runs
		// ahead of any leftover, and `drain` refuses a foreign Claim outright, so
		// this is the up-front diagnosis rather than the safety: fail here, once,
		// with the remedy, instead of somewhere in the middle of a drain loop.
		// Deliberately every queued Run, not only the currently claimable ones —
		// a foreign Run under a live lease becomes claimable when that lease lapses,
		// which is well within this suite's runtime.
		const [foreign] = await db
			.select({ runId: runs.runId })
			.from(runs)
			.where(eq(runs.status, "queued"))
			.limit(1);
		if (foreign) {
			throw new Error(
				`AGENT_DATABASE_URL already holds a queued Run (${foreign.runId}). ` +
					"This suite claims globally, so it needs a database with no queued Runs left over — " +
					"re-create it and re-apply the migrations, or point at a scratch one. " +
					"If this fired from the plain unit lane, unset AGENT_DATABASE_URL and the suite skips.",
			);
		}
	});

	beforeEach(deleteOwnRows);

	afterAll(async () => {
		await deleteOwnRows();
		await db.$client.end();
	});

	describe("concurrent reclaimers", () => {
		it("split lapsed Conversations across both lanes without double-terminalizing their Runs", async () => {
			await seedConversations("conv-a", "conv-b");
			await db
				.update(conversations)
				.set({ executionLane: "agentcore_canary" })
				.where(conversationKey("conv-a"));
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });
			await seedRun({ runId: "b", conversationId: "conv-b", order: 1 });
			await db
				.update(runs)
				.set({ status: "running" })
				.where(eq(runs.userId, USER_ID));
			await db
				.update(conversations)
				.set({
					ownerWorkerId: "vanished-worker",
					ownerUntil: sql`now() - interval '1 second'`,
				})
				.where(eq(conversations.userId, USER_ID));

			const reclaimed = await Promise.all([
				reclaimConversationTx(db),
				reclaimConversationTx(db),
			]);

			expect(
				reclaimed
					.map((result) => result?.conversationId)
					.filter((id): id is string => id !== undefined)
					.sort(),
			).toEqual(["conv-a", "conv-b"]);
			const outcomes = await db
				.select({ runId: runs.runId, status: runs.status })
				.from(runs)
				.where(eq(runs.userId, USER_ID));
			expect(
				outcomes.map(({ runId, status }) => [runId, status]).sort(),
			).toEqual([
				[ownedRunId("a"), "error"],
				[ownedRunId("b"), "error"],
			]);
		});

		it("skips a lapsed Conversation another session holds instead of blocking", async () => {
			await seedConversations("conv-a", "conv-b");
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });
			await seedRun({ runId: "b", conversationId: "conv-b", order: 1 });
			await db
				.update(runs)
				.set({ status: "running" })
				.where(eq(runs.userId, USER_ID));
			await db
				.update(conversations)
				.set({
					ownerWorkerId: "vanished-worker",
					ownerUntil: sql`now() - interval '1 second'`,
				})
				.where(eq(conversations.userId, USER_ID));

			const reclaimed = await operateWhileHeld(
				(tx) => lockConversationRow(tx, "conv-a"),
				() => reclaimConversationTx(db),
				"Reclamation",
			);

			expect(reclaimed?.conversationId).toBe("conv-b");
			expect(
				(
					await db
						.select()
						.from(runs)
						.where(eq(runs.runId, ownedRunId("a")))
				)[0]?.status,
			).toBe("running");
		});

		it("preserves an old queued Run when queue expiration races Reclamation", async () => {
			await seedConversations("conv-a");
			await seedRun({ runId: "running", conversationId: "conv-a", order: 0 });
			await seedRun({ runId: "queued", conversationId: "conv-a", order: 1 });
			await db
				.update(runs)
				.set({ status: "running" })
				.where(eq(runs.runId, ownedRunId("running")));
			await db
				.update(runs)
				.set({ updatedAt: submittedAt(1) })
				.where(eq(runs.runId, ownedRunId("queued")));
			await db
				.update(conversations)
				.set({
					ownerWorkerId: "vanished-worker",
					ownerUntil: sql`now() - interval '1 second'`,
				})
				.where(conversationKey("conv-a"));

			const [reclaimed, expired] = await Promise.all([
				reclaimConversationTx(db),
				expireUnownedQueuedRunsTx(db),
			]);

			expect(reclaimed?.conversationId).toBe("conv-a");
			expect(expired).toBeNull();
			expect(
				(
					await db
						.select({ status: runs.status })
						.from(runs)
						.where(eq(runs.runId, ownedRunId("queued")))
				)[0]?.status,
			).toBe("queued");
			expect(
				await claimConversationTx(db, { workerId: "successor-worker" }),
			).toMatchObject({
				conversationId: "conv-a",
				runIds: [ownedRunId("queued")],
			});
		});
	});

	describe("concurrent claimants", () => {
		it("keeps a Fargate Claim isolated from concurrent AgentCore-canary acquisition", async () => {
			await seedConversations("conv-agentcore", "conv-fargate");
			await db
				.update(conversations)
				.set({ executionLane: "agentcore_canary" })
				.where(conversationKey("conv-agentcore"));
			await seedRun({
				runId: "agentcore",
				conversationId: "conv-agentcore",
				order: 0,
			});
			await seedRun({
				runId: "fargate",
				conversationId: "conv-fargate",
				order: 1,
			});

			const claim = await claimWhileHeld(async (tx) => {
				await lockConversationRow(tx, "conv-agentcore");
				await tx
					.update(conversations)
					.set({
						ownerWorkerId: "agentcore-invocation",
						ownerUntil: sql`now() + interval '60 seconds'`,
					})
					.where(conversationKey("conv-agentcore"));
			}, "fargate-worker");

			expect(claim).toMatchObject({
				conversationId: "conv-fargate",
				runIds: [ownedRunId("fargate")],
			});
			expect(
				(
					await db
						.select({ ownerWorkerId: conversations.ownerWorkerId })
						.from(conversations)
						.where(conversationKey("conv-agentcore"))
				)[0]?.ownerWorkerId,
			).toBe("agentcore-invocation");
		});

		it("hands one Conversation to exactly one of them", async () => {
			await seedConversations("conv-a");
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });

			const claims = await Promise.all(
				["worker-1", "worker-2", "worker-3", "worker-4"].map((workerId) =>
					claimConversationTx(db, { workerId }),
				),
			);

			const winners = claims.filter((claim) => claim !== null);
			expect(winners).toHaveLength(1);
			expect(claimed(winners[0]).runIds).toEqual([ownedRunId("a")]);
		});

		it("gives them a Conversation each when there are enough to go round", async () => {
			await seedConversations("conv-a", "conv-b");
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });
			await seedRun({ runId: "b", conversationId: "conv-b", order: 1 });

			const claims = await Promise.all([
				claimConversationTx(db, { workerId: "worker-1" }),
				claimConversationTx(db, { workerId: "worker-2" }),
			]);

			const taken = claims.map((claim) => claimed(claim).conversationId).sort();
			expect(taken).toEqual(["conv-a", "conv-b"]);
		});

		it("skips a Conversation another session holds locked instead of waiting for it", async () => {
			await seedConversations("conv-a", "conv-b");
			// conv-a is the older candidate, so an unheld Claim would take it.
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });
			await seedRun({ runId: "b", conversationId: "conv-b", order: 1 });

			const claim = await claimWhileHeld(
				(tx) => lockConversationRow(tx, "conv-a"),
				"worker-2",
			);

			expect(claimed(claim).conversationId).toBe("conv-b");
		});

		it("takes nothing rather than waiting when the only candidate is held", async () => {
			await seedConversations("conv-a");
			await seedRun({ runId: "a", conversationId: "conv-a", order: 0 });

			const during = await claimWhileHeld(
				(tx) => lockConversationRow(tx, "conv-a"),
				"worker-1",
			);

			expect(during).toBe(null);
			// Skipping cost the claimant a tick, not the Conversation.
			expect(
				claimed(await claimConversationTx(db, { workerId: "worker-1" }))
					.conversationId,
			).toBe("conv-a");
		});
	});

	describe("a Run admitted concurrently with a Claim", () => {
		it("is deferred to the next Claim when its admission has not committed", async () => {
			await seedConversations("conv-a");
			await seedRun({ runId: "first", conversationId: "conv-a", order: 0 });

			const during = await claimWhileHeld(async (tx) => {
				await lockConversationRow(tx, "conv-a");
				await tx.insert(runs).values(
					queuedRunValues({
						runId: "late",
						conversationId: "conv-a",
						order: 1,
					}),
				);
			}, "worker-1");

			// The Conversation is a visible candidate — `first` is queued and
			// committed — so the Claim reached its row and skipped the held lock.
			expect(during).toBe(null);
			expect(
				claimed(await claimConversationTx(db, { workerId: "worker-2" })).runIds,
			).toEqual([ownedRunId("first"), ownedRunId("late")]);
		});

		it("lands in exactly one snapshot and is never lost", async () => {
			// Each round races one real admission against two claimants on a fresh
			// Conversation, then serves every snapshot taken, exactly as the workers
			// will. Which side of the Conversation row lock the admission falls on is
			// left to the backends: commit first and the Run is in the winning
			// Claim's snapshot, lose and the Conversation has no visible queued Run
			// to claim at all and it waits for the next round. Both are legal;
			// neither may lose it or serve it twice.
			//
			// Two claimants rather than one because that is what a fleet ticking
			// looks like, so each round fuzzes claim-versus-claim and
			// claim-versus-admission at once. Note what the equality below can and
			// cannot catch: a Run reaching two snapshots fails it, but every snapshot
			// is drained before the next round, so mutual exclusion is really pinned
			// by the dedicated concurrent-claimants tests above — this loop's own
			// force is that no admitted Run is ever lost.
			//
			// The queue is emptied before each round so the round's claimants have no
			// older candidate to prefer — otherwise every Claim serves the previous
			// round's leftover and never contends with the admission at all. The
			// staggered start is what makes both orders actually occur: with no
			// stagger the admission never once won, and at these offsets between a
			// half and two thirds of rounds landed inside the snapshot. The assertion
			// holds whichever way a given round lands.
			const ROUNDS = 24;
			const admitted: string[] = [];
			const served: string[] = [];
			// Seeded up front rather than per round: a Conversation with no queued
			// Run is never a Claim candidate, so their existence changes nothing
			// about which round can claim what.
			const conversationIds = Array.from(
				{ length: ROUNDS },
				(_, round) => `race-${round}`,
			);
			await seedConversations(...conversationIds);

			for (const [round, conversationId] of conversationIds.entries()) {
				served.push(...(await drainAll()));
				const runId = ownedRunId(conversationId);
				const staggered = Bun.sleep((round % 4) * 5);
				const [first, second] = await Promise.all([
					staggered.then(() =>
						claimConversationTx(db, { workerId: "worker-1" }),
					),
					staggered.then(() =>
						claimConversationTx(db, { workerId: "worker-2" }),
					),
					admitQueuedRunTx(db, {
						runId,
						userId: USER_ID,
						conversationId,
						messageId: `${runId}/message`,
						text: "hello",
						scope: "general",
						collectionId: null,
						summaryId: null,
					}),
				]);
				admitted.push(runId);
				for (const claim of [first, second]) {
					if (claim) served.push(...(await drain(claim)));
				}
			}
			served.push(...(await drainAll()));

			// Sorted set equality is the whole invariant: a duplicate is a Run served
			// by two Claims, a missing id is one no Claim ever saw.
			expect([...served].sort()).toEqual([...admitted].sort());
		});
	});

	// The supersession is established deterministically — Claim, lapse the lease,
	// re-Claim — so the assertion is about the fence rather than about who won a
	// race, which would only be assertable as a coin flip. What real Postgres
	// contributes is the concurrency below it: two backends writing the same row,
	// and a release racing a renewal, neither of which one backend can perform.
	describe("a superseded holder", () => {
		it("has its fenced write refused while its successor's succeeds", async () => {
			const { superseded, successor } = await supersede();

			const [staleWrote, successorWrote] = await Promise.all([
				fencedStamp(superseded, "worker-1", "a"),
				fencedStamp(successor, "worker-2", "a"),
			]);

			expect(staleWrote).toBe(false);
			expect(successorWrote).toBe(true);
		});

		it("cannot take the Conversation back by releasing it", async () => {
			const { superseded, successor } = await supersede();

			const [released, renewed] = await Promise.all([
				releaseConversationTx(db, superseded),
				renewConversationLeaseTx(db, successor),
			]);

			expect(released).toBe(false);
			expect(renewed).not.toBe(null);
			// The Conversation is still the successor's, so nobody else can take it.
			expect(await claimConversationTx(db, { workerId: "worker-3" })).toBe(
				null,
			);
		});
	});
});
