import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { eq } from "drizzle-orm";
import {
	type AgentCoreDispatchIdentity,
	acquireAgentCoreDispatchTx,
	claimAgentCoreDispatchesTx,
	loadAgentCoreDispatchRunStatus,
} from "./agentcore-dispatch";
import { createDatabase, type Database } from "./client";
import { requestRunInterruptionTx, transitionRunTerminalTx } from "./run-store";
import { agentCoreDispatchOutbox, conversations, runs } from "./schema";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";
if (RUN) setDefaultTimeout(30_000);

const TEST_ID = `agentcore-dispatch-${crypto.randomUUID()}`;
let db: Database;

function input(suffix: "a" | "b") {
	return {
		userId: TEST_ID,
		conversationId: `${TEST_ID}-conversation-${suffix}`,
		runId: `${TEST_ID}-run-${suffix}`,
	} as const;
}

async function deleteOwnRows(): Promise<void> {
	await db
		.delete(agentCoreDispatchOutbox)
		.where(eq(agentCoreDispatchOutbox.userId, TEST_ID));
	await db.delete(conversations).where(eq(conversations.userId, TEST_ID));
}

async function seedDispatch(
	exact: ReturnType<typeof input>,
): Promise<AgentCoreDispatchIdentity> {
	const admittedAt = new Date();
	await db.transaction(async (tx) => {
		await tx.insert(conversations).values({
			userId: exact.userId,
			conversationId: exact.conversationId,
			scope: "general",
			executionRuntime: "agentcore",
		});
		await tx.insert(runs).values({
			runId: exact.runId,
			userId: exact.userId,
			conversationId: exact.conversationId,
			status: "queued",
		});
		await tx.insert(agentCoreDispatchOutbox).values({
			userId: exact.userId,
			conversationId: exact.conversationId,
			runId: exact.runId,
			admittedAt,
		});
	});
	return {
		schemaVersion: 2,
		userId: exact.userId,
		conversationId: exact.conversationId,
		runId: exact.runId,
		runtimeSessionId: exact.conversationId,
		admittedAt,
	};
}

describe.skipIf(!RUN)(
	"AgentCore dispatch concurrency against real Postgres",
	() => {
		beforeAll(async () => {
			db = createDatabase(DB_URL);
			await deleteOwnRows();
		});

		beforeEach(deleteOwnRows);

		afterAll(async () => {
			await deleteOwnRows();
			await db.$client.end();
		});

		it("lets only one concurrent publisher lease an exact Run dispatch", async () => {
			const exact = input("a");
			await seedDispatch(exact);
			const now = new Date();
			const acquisitions = await Promise.all([
				claimAgentCoreDispatchesTx(db, { publisherId: "publisher-a", now }),
				claimAgentCoreDispatchesTx(db, { publisherId: "publisher-b", now }),
			]);

			expect(
				acquisitions.map((acquisition) => acquisition.length).sort(),
			).toEqual([0, 1]);
			expect(acquisitions.flat()[0]?.runId).toBe(exact.runId);
		});

		it("prechecks a terminal Run admitted with PostgreSQL's default timestamp", async () => {
			const exact = input("a");
			await db.transaction(async (tx) => {
				await tx.insert(conversations).values({
					userId: exact.userId,
					conversationId: exact.conversationId,
					scope: "general",
					executionRuntime: "agentcore",
				});
				await tx.insert(runs).values({
					runId: exact.runId,
					userId: exact.userId,
					conversationId: exact.conversationId,
					status: "queued",
				});
				await tx.insert(agentCoreDispatchOutbox).values({
					userId: exact.userId,
					conversationId: exact.conversationId,
					runId: exact.runId,
				});
			});
			const [dispatch] = await claimAgentCoreDispatchesTx(db, {
				publisherId: "publisher-default-timestamp",
			});
			if (!dispatch) throw new Error("test dispatch was not acquired");
			await db
				.update(runs)
				.set({ status: "done" })
				.where(eq(runs.runId, exact.runId));

			await expect(loadAgentCoreDispatchRunStatus(db, dispatch)).resolves.toBe(
				"done",
			);
		});

		it("serializes duplicate Runtime invocations to acquired then already_acquired", async () => {
			const exact = input("a");
			const dispatch = await seedDispatch(exact);

			const results = await Promise.all([
				acquireAgentCoreDispatchTx(db, {
					dispatch,
					workerId: "agentcore-invocation-a",
				}),
				acquireAgentCoreDispatchTx(db, {
					dispatch,
					workerId: "agentcore-invocation-b",
				}),
			]);

			expect(results.map(({ disposition }) => disposition).sort()).toEqual([
				"acquired",
				"already_acquired",
			]);
		});

		it("never reacquires expired running Ownership before Reclamation", async () => {
			const exact = input("a");
			const dispatch = await seedDispatch(exact);
			const acquiredAt = new Date();
			await acquireAgentCoreDispatchTx(db, {
				dispatch,
				workerId: "agentcore-dead-invocation",
				now: acquiredAt,
			});

			await expect(
				acquireAgentCoreDispatchTx(db, {
					dispatch,
					workerId: "agentcore-retry-invocation",
					now: new Date(acquiredAt.getTime() + 60_001),
				}),
			).resolves.toEqual({ disposition: "temporarily_unavailable" });
		});

		it("serializes queued interruption against exact acquisition without a second execution", async () => {
			const exact = input("a");
			const dispatch = await seedDispatch(exact);

			const [acquisition, interruption] = await Promise.all([
				acquireAgentCoreDispatchTx(db, {
					dispatch,
					workerId: "agentcore-terminal-racer",
				}),
				requestRunInterruptionTx(db, {
					runId: exact.runId,
					userId: exact.userId,
					conversationId: exact.conversationId,
				}),
			]);

			expect(["acquired", "terminal"]).toContain(acquisition.disposition);
			expect(["interrupted", "interrupt_requested"]).toContain(
				interruption.outcome,
			);
		});

		it("serializes a terminal commit against a duplicate exact acquisition", async () => {
			const exact = input("a");
			const dispatch = await seedDispatch(exact);
			const first = await acquireAgentCoreDispatchTx(db, {
				dispatch,
				workerId: "agentcore-terminal-owner",
			});
			if (first.disposition !== "acquired") {
				throw new Error("test setup did not acquire the Run");
			}

			const [duplicate, terminal] = await Promise.all([
				acquireAgentCoreDispatchTx(db, {
					dispatch,
					workerId: "agentcore-terminal-racer",
				}),
				transitionRunTerminalTx(db, {
					owner: {
						...first.owner,
						runId: exact.runId,
						workerId: first.workerId,
					},
					status: "done",
				}),
			]);

			expect(["already_acquired", "terminal"]).toContain(duplicate.disposition);
			expect(terminal).toMatchObject({
				outcome: "committed",
				run: { status: "done" },
			});
		});
	},
);
