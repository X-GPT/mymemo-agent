import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createDatabase, type Database, type DbTx } from "./client";
import { expireUnownedQueuedRunsTx, reclaimConversationTx } from "./run-store";
import { conversations, runs } from "./schema";

/**
 * Reclamation's concurrency properties (ADR-0015), against real PostgreSQL.
 * PGlite has only one backend, so it cannot prove `SKIP LOCKED` behavior or a
 * race between Reclamation and queued-Run expiration. Fargate Claim coverage
 * was removed when Conversation creation became AgentCore-only.
 */

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";
const USER_ID = `reclamation-${crypto.randomUUID()}`;
const NON_BLOCKING_MS = 10_000;
const FIRST_SUBMISSION_MS = Date.parse("2000-01-01T00:00:00Z");

if (RUN) setDefaultTimeout(30_000);

let db: Database;

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
			executionRuntime: "agentcore" as const,
		})),
	);
}

async function seedRun(input: {
	runId: string;
	conversationId: string;
	order: number;
}): Promise<void> {
	await db.insert(runs).values({
		runId: ownedRunId(input.runId),
		userId: USER_ID,
		conversationId: input.conversationId,
		status: "queued",
		createdAt: submittedAt(input.order),
	});
}

async function deleteOwnRows(): Promise<void> {
	await db.delete(conversations).where(eq(conversations.userId, USER_ID));
}

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
	held.catch((error) => opened.reject(error));
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

describe.skipIf(!RUN)("Reclamation against real Postgres", () => {
	beforeAll(() => {
		db = createDatabase(DB_URL);
	});

	beforeEach(deleteOwnRows);

	afterAll(async () => {
		await deleteOwnRows();
		await db.$client.end();
	});

	it("splits lapsed AgentCore Conversations across concurrent reclaimers", async () => {
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
				ownerWorkerId: "vanished-agentcore-runtime",
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
		expect(
			(
				await db
					.select({ runId: runs.runId, status: runs.status })
					.from(runs)
					.where(eq(runs.userId, USER_ID))
			)
				.map(({ runId, status }) => [runId, status])
				.sort(),
		).toEqual([
			[ownedRunId("a"), "error"],
			[ownedRunId("b"), "error"],
		]);
	});

	it("skips a lapsed Conversation another session holds", async () => {
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
				ownerWorkerId: "vanished-agentcore-runtime",
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
					.select({ status: runs.status })
					.from(runs)
					.where(eq(runs.runId, ownedRunId("a")))
			)[0]?.status,
		).toBe("running");
	});

	it("preserves a queued Run when expiration races Reclamation", async () => {
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
				ownerWorkerId: "vanished-agentcore-runtime",
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
	});
});
