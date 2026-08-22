import { describe, expect, it } from "bun:test";
import {
	claimAgentCoreDispatchesTx,
	recordAgentCoreDispatchInTx,
} from "@mymemo/agent-db/agentcore-dispatch";
import { admitQueuedRunInTx } from "@mymemo/agent-db/run-store";
import { conversations, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase } from "@mymemo/agent-db/testing";
import { createDatabaseAgentCoreAcquisitionBoundary } from "./acquisition-boundary";
import {
	parseAcquisitionReceipt,
	serializeAgentCoreDispatchEnvelope,
} from "./contract";

describe("AgentCore dispatch flow through PGlite", () => {
	it("takes admission-with-outbox through claim, envelope, and exact acquisition", async () => {
		const tdb = await createTestDatabase();
		const admittedAt = new Date("2026-08-14T16:00:00.000Z");
		const userId = "agentcore-e2e-user";
		const conversationId = "0198b5a2-0d2b-7b64-9f65-4c9d49045001";
		const runId = "0198b5a2-1c70-7be1-8e52-acdeab984501";

		try {
			await tdb.db.insert(conversations).values({
				userId,
				conversationId,
				scope: "general",
			});
			await tdb.db.transaction(async (tx) => {
				const admission = await admitQueuedRunInTx(tx, {
					runId,
					userId,
					conversationId,
					messageId: "0198b5a2-2c70-7855-b090-acdeab984502",
					text: "Run the admitted AgentCore turn.",
					scope: "general",
					collectionId: null,
					summaryId: null,
				});
				expect(admission.outcome).toBe("created");
				await recordAgentCoreDispatchInTx(tx, {
					userId,
					conversationId,
					runId,
					admittedAt,
				});
			});

			const [claimed] = await claimAgentCoreDispatchesTx(tdb.db, {
				publisherId: "publisher-1",
				now: new Date("2026-08-14T16:01:00.000Z"),
			});
			if (!claimed) throw new Error("dispatch was not claimed");

			const boundary = createDatabaseAgentCoreAcquisitionBoundary({
				db: tdb.db,
				bootId: "agentcore-e2e",
				control: { isEnabled: async () => true },
				now: () => new Date("2026-08-14T16:01:00.000Z"),
			});
			const committed = await boundary.acquire(
				serializeAgentCoreDispatchEnvelope(claimed),
			);

			expect(committed.dispatch).toEqual(claimed);
			expect(committed.result).toMatchObject({
				disposition: "acquired",
				owner: { userId, conversationId, epoch: 1 },
				workerId: expect.stringMatching(/^agentcore-e2e\//),
			});
			expect(
				parseAcquisitionReceipt(committed.receiptLine.trim()),
			).toMatchObject({
				schemaVersion: 2,
				userId,
				conversationId,
				runId,
				runtimeSessionId: conversationId,
				disposition: "acquired",
				ownershipEpoch: 1,
				workerId: expect.stringMatching(/^agentcore-e2e\//),
			});
			expect(await tdb.db.select().from(runs)).toMatchObject([
				{
					runId,
					status: "running",
					executedByWorkerId: expect.stringMatching(/^agentcore-e2e\//),
				},
			]);
		} finally {
			await tdb.close();
		}
	});
});
