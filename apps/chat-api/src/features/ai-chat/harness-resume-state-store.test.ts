import { afterAll, beforeAll, expect, it } from "bun:test";
import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import { conversationRuntime } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { PostgresHarnessResumeStateStore } from "./harness-resume-state-store";

let tdb: TestDb;
let store: PostgresHarnessResumeStateStore;

beforeAll(async () => {
	tdb = await createTestDatabase();
	store = new PostgresHarnessResumeStateStore(tdb.db);
});

afterAll(() => tdb.close());

const ref = { userId: "user-1", conversationId: "conv-1" };
const state = (n: number): HarnessAgentResumeSessionState =>
	({ type: "resume-session", data: { turn: n } }) as never;

it("round-trips the pointer verbatim, creating the runtime row on first save", async () => {
	expect(await store.load(ref)).toBeNull();
	await store.save(ref, state(1));
	expect(await store.load(ref)).toEqual(state(1));
	// A later turn replaces the pointer on the existing row.
	await store.save(ref, state(2));
	expect(await store.load(ref)).toEqual(state(2));
	expect(await tdb.db.select().from(conversationRuntime)).toHaveLength(1);
	expect(
		await store.load({ userId: "user-2", conversationId: "conv-1" }),
	).toBeNull();
});
