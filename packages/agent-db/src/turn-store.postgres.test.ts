import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import { createDatabase, type Database } from "./client";
import { conversationMessages, conversations } from "./schema";
import {
	claimNextTurnTx,
	enqueueTurnTx,
	type TurnOutcome,
	terminalizeTurnTx,
} from "./turn-store";

/**
 * Turn-queue concurrency (spec #654, ticket #656) against real PostgreSQL.
 * PGlite has one backend, so it cannot prove that concurrent claimers get at
 * most one winner or that racing terminalizers publish exactly one Outcome.
 */

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "";
const USER_ID = `turn-queue-${crypto.randomUUID()}`;
const CONVERSATION_ID = "turn-race-conversation";

if (RUN) setDefaultTimeout(30_000);

let db: Database;

async function deleteOwnRows(): Promise<void> {
	await db.delete(conversations).where(eq(conversations.userId, USER_ID));
}

async function enqueue(messageId: string): Promise<void> {
	await enqueueTurnTx(db, {
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		messageId,
		parts: [],
	});
}

async function ownTurnStatuses(): Promise<Array<[string, string | null]>> {
	const rows = await db
		.select({
			messageId: conversationMessages.messageId,
			status: conversationMessages.status,
		})
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, USER_ID),
				eq(conversationMessages.conversationId, CONVERSATION_ID),
			),
		);
	return rows.map(({ messageId, status }): [string, string | null] => [
		messageId,
		status,
	]);
}

describe.skipIf(!RUN)("Turn queue against real Postgres", () => {
	beforeAll(() => {
		db = createDatabase(DB_URL);
	});

	beforeEach(async () => {
		await deleteOwnRows();
		await db.insert(conversations).values({
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
			scope: "general",
		});
	});

	afterAll(async () => {
		await deleteOwnRows();
		await db.$client.end();
	});

	it("concurrent claimers get at most one winner, and it is the lowest sequence", async () => {
		await enqueue("m1");
		await enqueue("m2");
		await enqueue("m3");

		const claims = await Promise.all(
			Array.from({ length: 6 }, () =>
				claimNextTurnTx(db, {
					userId: USER_ID,
					conversationId: CONVERSATION_ID,
				}),
			),
		);

		const winners = claims.filter((claim) => claim !== null);
		expect(winners.map(({ messageId }) => messageId)).toEqual(["m1"]);
		expect((await ownTurnStatuses()).sort()).toEqual([
			["m1", "processing"],
			["m2", "queued"],
			["m3", "queued"],
		]);
	});

	it("racing terminalizers publish exactly one Outcome", async () => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		const outcomes: TurnOutcome[] = ["done", "error", "interrupted"];
		const results = await Promise.all(
			outcomes.map((outcome) =>
				terminalizeTurnTx(db, {
					userId: USER_ID,
					conversationId: CONVERSATION_ID,
					messageId: "m1",
					outcome,
				}),
			),
		);

		expect(results.filter(Boolean)).toHaveLength(1);
		const winner = outcomes[results.indexOf(true)];
		if (!winner) throw new Error("no terminalizer won");
		expect((await ownTurnStatuses()).sort()).toEqual([["m1", winner]]);
	});
});
