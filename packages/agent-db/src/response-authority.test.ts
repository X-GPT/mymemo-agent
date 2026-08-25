import { expect, it } from "bun:test";
import {
	clearConversationResponseAuthorityTx,
	renewConversationResponseAuthorityTx,
	verifyConversationResponseAuthorityTx,
} from "./response-authority";
import { conversations } from "./schema";
import { createTestDatabase } from "./testing";

it("fences the Response lifecycle by kind, epoch, and deadline", async () => {
	const tdb = await createTestDatabase();
	try {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			epoch: 7,
			ownerUntil: new Date(Date.now() + 30_000),
		});
		const authority = { conversationId: "conversation-1", epoch: 7 };

		expect(
			await verifyConversationResponseAuthorityTx(tdb.db, authority),
		).toBeInstanceOf(Date);
		expect(
			await renewConversationResponseAuthorityTx(tdb.db, authority),
		).toBeInstanceOf(Date);
		await tdb.db.update(conversations).set({
			ownerUntil: new Date(Date.now() - 1_000),
		});
		expect(
			await renewConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
		await tdb.db.update(conversations).set({
			ownerWorkerId: "run-owner",
			ownerUntil: new Date(Date.now() + 30_000),
		});
		expect(
			await verifyConversationResponseAuthorityTx(tdb.db, authority),
		).toBeNull();
		await tdb.db.update(conversations).set({ ownerWorkerId: null });
		expect(await clearConversationResponseAuthorityTx(tdb.db, authority)).toBe(
			true,
		);
	} finally {
		await tdb.close();
	}
});
