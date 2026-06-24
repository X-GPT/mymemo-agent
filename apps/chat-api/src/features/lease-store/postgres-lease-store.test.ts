import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createTestDatabase } from "@/db/testing";
import type { LeaseRecord } from "./lease-store";
import { PostgresLeaseStore } from "./postgres-lease-store";

const record: LeaseRecord = {
	userId: "user-1",
	conversationId: "conv-1",
	sandboxId: "sbx-1",
	agentSessionId: "sess-1",
};

describe("PostgresLeaseStore", () => {
	let store: PostgresLeaseStore;
	let close: () => Promise<void>;

	beforeEach(async () => {
		const tdb = await createTestDatabase();
		close = tdb.close;
		store = new PostgresLeaseStore(tdb.db);
	});

	afterEach(() => close());

	it("get returns null when no row matches", async () => {
		expect(
			await store.get({ userId: "nobody", conversationId: "none" }),
		).toBeNull();
	});

	it("upsert then get round-trips the record by the composite key", async () => {
		await store.upsert(record);
		expect(
			await store.get({ userId: "user-1", conversationId: "conv-1" }),
		).toEqual(record);
	});

	it("upsert replaces the pointer for the same key without adding a row", async () => {
		await store.upsert(record);
		await store.upsert({
			...record,
			sandboxId: "sbx-2",
			agentSessionId: "sess-2",
		});

		const got = await store.get({ userId: "user-1", conversationId: "conv-1" });
		expect(got).toEqual({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sbx-2",
			agentSessionId: "sess-2",
		});
	});

	it("isolates rows by user and by conversation", async () => {
		await store.upsert(record);
		await store.upsert({ ...record, userId: "user-2", sandboxId: "sbx-other" });

		expect(
			(await store.get({ userId: "user-1", conversationId: "conv-1" }))
				?.sandboxId,
		).toBe("sbx-1");
		expect(
			(await store.get({ userId: "user-2", conversationId: "conv-1" }))
				?.sandboxId,
		).toBe("sbx-other");
	});

	it("round-trips a null agent session", async () => {
		await store.upsert({ ...record, agentSessionId: null });
		const got = await store.get({ userId: "user-1", conversationId: "conv-1" });
		expect(got?.agentSessionId).toBeNull();
	});

	it("delete removes the row by the composite key", async () => {
		await store.upsert(record);
		await store.delete({ userId: "user-1", conversationId: "conv-1" });
		expect(
			await store.get({ userId: "user-1", conversationId: "conv-1" }),
		).toBeNull();
	});
});
