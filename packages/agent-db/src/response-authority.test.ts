import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import {
	clearConversationResponseAuthorityTx,
	lockLiveConversationResponseAuthorityTx,
	renewConversationResponseAuthorityTx,
	verifyConversationResponseAuthorityTx,
} from "./response-authority";
import { conversations } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

describe("Conversation response authority", () => {
	let tdb: TestDb;

	beforeAll(async () => {
		tdb = await createTestDatabase();
	});

	afterAll(async () => {
		await tdb.close();
	});

	it("verifies, renews, fences stale epochs, and conditionally clears", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
			ownerUntil: new Date(Date.now() + 30_000),
			activeStreamId: "stream-1",
		});

		const authority = { conversationId: "conversation-1", epoch: 7 };
		const verified = await verifyConversationResponseAuthorityTx(
			tdb.db,
			authority,
		);
		expect(verified).toBeInstanceOf(Date);

		const renewed = await renewConversationResponseAuthorityTx(
			tdb.db,
			authority,
		);
		expect(renewed).toBeInstanceOf(Date);
		expect(renewed?.getTime()).toBeGreaterThan(verified?.getTime() ?? 0);

		await expect(
			tdb.db.transaction((tx) =>
				lockLiveConversationResponseAuthorityTx(tx, {
					conversationId: "conversation-1",
					epoch: 6,
				}),
			),
		).rejects.toThrow("response authority");
		expect(
			await clearConversationResponseAuthorityTx(tdb.db, {
				conversationId: "conversation-1",
				epoch: 6,
			}),
		).toBe(false);
		await tdb.db.update(conversations).set({ ownerWorkerId: "run-owner" });
		expect(
			await verifyConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
		expect(await clearConversationResponseAuthorityTx(tdb.db, authority)).toBe(
			false,
		);
		await tdb.db.update(conversations).set({ ownerWorkerId: null });
		expect(await clearConversationResponseAuthorityTx(tdb.db, authority)).toBe(
			true,
		);
		expect(
			await verifyConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
	});

	it("never revives an expired deadline", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-expired",
			scope: "general",
			epoch: 3,
			ownerUntil: new Date(Date.now() - 1_000),
		});
		const authority = { conversationId: "conversation-expired", epoch: 3 };

		expect(
			await verifyConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
		expect(
			await renewConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
	});
});
