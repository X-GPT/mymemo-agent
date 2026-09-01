import { afterAll, beforeAll, expect, it } from "bun:test";
import { documentAccessEvents } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { PostgresDocumentAccessLog } from "./access-log";

let tdb: TestDb;
beforeAll(async () => {
	tdb = await createTestDatabase();
});
afterAll(() => tdb.close());

it("appends one row per call with the Harness turn id in run_id", async () => {
	const log = new PostgresDocumentAccessLog(tdb.db);
	await log.record({
		turnId: "turn-1",
		conversationId: "conv-1",
		userId: "member-1",
		operation: "search",
		scopeType: "collection",
		scopeId: "coll-7",
		query: "revenue",
		documentIds: ["d1", "d2"],
		resultCount: 3,
	});
	await log.record({
		turnId: "turn-1",
		conversationId: "conv-1",
		userId: "member-1",
		operation: "load",
		scopeType: "general",
		scopeId: null,
		query: null,
		documentIds: ["d1"],
		resultCount: 1,
	});
	const rows = await tdb.db
		.select({
			runId: documentAccessEvents.runId,
			operation: documentAccessEvents.operation,
			scopeType: documentAccessEvents.scopeType,
			scopeId: documentAccessEvents.scopeId,
			query: documentAccessEvents.query,
			documentIds: documentAccessEvents.documentIds,
			resultCount: documentAccessEvents.resultCount,
		})
		.from(documentAccessEvents)
		.orderBy(documentAccessEvents.id);
	expect(rows).toEqual([
		{
			runId: "turn-1",
			operation: "search",
			scopeType: "collection",
			scopeId: "coll-7",
			query: "revenue",
			documentIds: ["d1", "d2"],
			resultCount: 3,
		},
		{
			runId: "turn-1",
			operation: "load",
			scopeType: "general",
			scopeId: null,
			query: null,
			documentIds: ["d1"],
			resultCount: 1,
		},
	]);
});
