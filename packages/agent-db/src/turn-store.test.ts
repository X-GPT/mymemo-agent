import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Database } from "./client";
import { conversationMessages, conversations } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";
import {
	cancelQueuedTurnTx,
	claimNextTurnTx,
	enqueueTurnTx,
	sweepStaleProcessingTurnsTx,
	type TurnOutcome,
	terminalizeTurnTx,
} from "./turn-store";

const USER_ID = "turn-user";
const CONVERSATION_ID = "turn-conversation";

let tdb: TestDb;
let db: Database;

beforeAll(async () => {
	tdb = await createTestDatabase();
	db = tdb.db;
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await db.delete(conversations);
	await db.insert(conversations).values({
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		scope: "general",
	});
});

function turnIdentity(messageId: string) {
	return { userId: USER_ID, conversationId: CONVERSATION_ID, messageId };
}

async function enqueue(messageId: string) {
	return await enqueueTurnTx(db, {
		...turnIdentity(messageId),
		parts: [{ type: "text", text: messageId }],
	});
}

async function loadTurn(messageId: string) {
	const [row] = await db
		.select()
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, USER_ID),
				eq(conversationMessages.conversationId, CONVERSATION_ID),
				eq(conversationMessages.messageId, messageId),
			),
		);
	if (!row) throw new Error(`turn ${messageId} not found`);
	return row;
}

describe("enqueueTurnTx", () => {
	it("admits a user message as a queued Turn", async () => {
		expect(await enqueue("m1")).toEqual({ enqueued: true });

		const turn = await loadTurn("m1");
		expect(turn.role).toBe("user");
		expect(turn.status).toBe("queued");
		expect(turn.startedAt).toBeNull();
		expect(turn.finishedAt).toBeNull();
	});

	it("reports a duplicate client message id as a no-op and leaves the row untouched", async () => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		const duplicate = await enqueueTurnTx(db, {
			...turnIdentity("m1"),
			parts: [{ type: "text", text: "replacement" }],
		});

		expect(duplicate).toEqual({ enqueued: false });
		const turn = await loadTurn("m1");
		expect(turn.status).toBe("processing");
		expect(turn.parts).toEqual([{ type: "text", text: "m1" }]);
	});
});

describe("claimNextTurnTx", () => {
	it("returns null when nothing is queued", async () => {
		expect(
			await claimNextTurnTx(db, {
				userId: USER_ID,
				conversationId: CONVERSATION_ID,
			}),
		).toBeNull();
	});

	it("claims the lowest-sequence queued Turn and stamps started_at", async () => {
		await enqueue("m1");
		await enqueue("m2");

		const claimed = await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(claimed?.messageId).toBe("m1");
		expect(claimed?.status).toBe("processing");
		expect(claimed?.startedAt).toBeInstanceOf(Date);
		expect((await loadTurn("m2")).status).toBe("queued");
	});

	it("claims nothing while a Turn is processing", async () => {
		await enqueue("m1");
		await enqueue("m2");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(
			await claimNextTurnTx(db, {
				userId: USER_ID,
				conversationId: CONVERSATION_ID,
			}),
		).toBeNull();
	});

	it("claims the next Turn once the previous one terminalizes", async () => {
		await enqueue("m1");
		await enqueue("m2");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		await terminalizeTurnTx(db, { ...turnIdentity("m1"), outcome: "done" });

		const claimed = await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		expect(claimed?.messageId).toBe("m2");
	});

	it("skips a cancelled Turn and claims the next queued one", async () => {
		await enqueue("m1");
		await enqueue("m2");
		await cancelQueuedTurnTx(db, turnIdentity("m1"));

		const claimed = await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		expect(claimed?.messageId).toBe("m2");
	});
});

describe("terminalizeTurnTx", () => {
	it.each([
		"done",
		"error",
		"interrupted",
	] as TurnOutcome[])("moves a processing Turn to %s with finished_at", async (outcome) => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(
			await terminalizeTurnTx(db, { ...turnIdentity("m1"), outcome }),
		).toBe(true);
		const turn = await loadTurn("m1");
		expect(turn.status).toBe(outcome);
		expect(turn.finishedAt).toBeInstanceOf(Date);
	});

	it("never transitions a terminal Turn again", async () => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		await terminalizeTurnTx(db, { ...turnIdentity("m1"), outcome: "done" });

		expect(
			await terminalizeTurnTx(db, { ...turnIdentity("m1"), outcome: "error" }),
		).toBe(false);
		expect((await loadTurn("m1")).status).toBe("done");
	});

	it("refuses a Turn that is still queued", async () => {
		await enqueue("m1");

		expect(
			await terminalizeTurnTx(db, { ...turnIdentity("m1"), outcome: "done" }),
		).toBe(false);
		expect((await loadTurn("m1")).status).toBe("queued");
	});
});

describe("sweepStaleProcessingTurnsTx", () => {
	it("terminalizes stale processing Turns as interrupted and leaves queued ones", async () => {
		await enqueue("m1");
		await enqueue("m2");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		const swept = await sweepStaleProcessingTurnsTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(swept).toEqual(["m1"]);
		expect((await loadTurn("m1")).status).toBe("interrupted");
		expect((await loadTurn("m1")).finishedAt).toBeInstanceOf(Date);
		expect((await loadTurn("m2")).status).toBe("queued");
	});

	it("sweeps nothing on a repeat pass — interrupted Turns are terminal", async () => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		await sweepStaleProcessingTurnsTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(
			await sweepStaleProcessingTurnsTx(db, {
				userId: USER_ID,
				conversationId: CONVERSATION_ID,
			}),
		).toEqual([]);
		expect((await loadTurn("m1")).status).toBe("interrupted");
	});
});

describe("cancelQueuedTurnTx", () => {
	it("terminalizes a queued Turn directly to interrupted without starting it", async () => {
		await enqueue("m1");

		expect(await cancelQueuedTurnTx(db, turnIdentity("m1"))).toBe(true);
		const turn = await loadTurn("m1");
		expect(turn.status).toBe("interrupted");
		expect(turn.startedAt).toBeNull();
		expect(turn.finishedAt).toBeInstanceOf(Date);
	});

	it("refuses a processing Turn", async () => {
		await enqueue("m1");
		await claimNextTurnTx(db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});

		expect(await cancelQueuedTurnTx(db, turnIdentity("m1"))).toBe(false);
		expect((await loadTurn("m1")).status).toBe("processing");
	});
});

describe("turn status database invariant", () => {
	it("rejects a user row without a legal Turn status", async () => {
		await expect(
			db
				.insert(conversationMessages)
				.values({
					...turnIdentity("bad"),
					role: "user",
					parts: [],
					status: "sideways",
				})
				.execute(),
		).rejects.toThrow();
		await expect(
			db
				.insert(conversationMessages)
				.values({ ...turnIdentity("bad"), role: "user", parts: [] })
				.execute(),
		).rejects.toThrow();
	});

	it("rejects an assistant row carrying a Turn status", async () => {
		await expect(
			db
				.insert(conversationMessages)
				.values({
					...turnIdentity("bad"),
					role: "assistant",
					parts: [],
					status: "queued",
				})
				.execute(),
		).rejects.toThrow();
	});
});
