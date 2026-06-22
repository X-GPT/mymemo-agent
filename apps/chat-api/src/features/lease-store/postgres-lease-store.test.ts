import { describe, expect, it } from "bun:test";
import type { Db } from "./db";
import type { LeaseRecord } from "./lease-store";
import { PostgresLeaseStore } from "./postgres-lease-store";

interface Call {
	text: string;
	params: unknown[];
}

/** Records every query and returns a scripted result set, so SQL + param
 * mapping are asserted without a live Postgres (mirrors the gateway's fake Db). */
function fakeDb(rows: Record<string, unknown>[] = []): Db & { calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		async query<T>(text: string, params: unknown[] = []) {
			calls.push({ text, params });
			return rows as T[];
		},
	};
}

/** The first recorded query, asserting one ran (keeps strict indexing happy). */
function firstCall(db: { calls: Call[] }): Call {
	const call = db.calls[0];
	if (!call) throw new Error("expected a query to have run");
	return call;
}

const record: LeaseRecord = {
	userId: "user-1",
	conversationId: "conv-1",
	sandboxId: "sbx-1",
	daemonUrl: "http://daemon:8080",
	trafficAccessToken: "tok",
	agentSessionId: "sess-1",
};

describe("PostgresLeaseStore", () => {
	it("get selects by the composite key and maps the row to a record", async () => {
		const db = fakeDb([
			{
				user_id: "user-1",
				conversation_id: "conv-1",
				sandbox_id: "sbx-1",
				daemon_url: "http://daemon:8080",
				traffic_access_token: "tok",
				agent_session_id: "sess-1",
			},
		]);
		const store = new PostgresLeaseStore(db);

		const got = await store.get({ userId: "user-1", conversationId: "conv-1" });

		expect(got).toEqual(record);
		expect(firstCall(db).params).toEqual(["user-1", "conv-1"]);
		expect(firstCall(db).text).toContain("FROM sandbox_leases");
		expect(firstCall(db).text).toContain(
			"WHERE user_id = $1 AND conversation_id = $2",
		);
	});

	it("get returns null when no row matches", async () => {
		const store = new PostgresLeaseStore(fakeDb([]));
		expect(
			await store.get({ userId: "nobody", conversationId: "none" }),
		).toBeNull();
	});

	it("get maps a null traffic token and session to null fields", async () => {
		const db = fakeDb([
			{
				user_id: "u",
				conversation_id: "c",
				sandbox_id: "s",
				daemon_url: "http://d",
				traffic_access_token: null,
				agent_session_id: null,
			},
		]);
		const got = await new PostgresLeaseStore(db).get({
			userId: "u",
			conversationId: "c",
		});
		expect(got?.trafficAccessToken).toBeNull();
		expect(got?.agentSessionId).toBeNull();
	});

	it("upsert writes all columns and is keyed by the conversation PK", async () => {
		const db = fakeDb();
		await new PostgresLeaseStore(db).upsert(record);

		const call = firstCall(db);
		expect(call.text).toContain("INSERT INTO sandbox_leases");
		expect(call.text).toContain(
			"ON CONFLICT (user_id, conversation_id) DO UPDATE",
		);
		expect(call.params).toEqual([
			"user-1",
			"conv-1",
			"sbx-1",
			"http://daemon:8080",
			"tok",
			"sess-1",
		]);
	});

	it("delete removes the row by the composite key", async () => {
		const db = fakeDb();
		await new PostgresLeaseStore(db).delete({
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(firstCall(db).text).toContain("DELETE FROM sandbox_leases");
		expect(firstCall(db).params).toEqual(["user-1", "conv-1"]);
	});
});
