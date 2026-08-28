import { afterAll, beforeAll, expect, it } from "bun:test";
import type { HarnessAgentResumeSessionState } from "@ai-sdk/harness/agent";
import { conversationRuntime } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { PostgresHarnessRuntimeStore } from "./harness-runtime-store";

let tdb: TestDb;
let store: PostgresHarnessRuntimeStore;

beforeAll(async () => {
	tdb = await createTestDatabase();
	store = new PostgresHarnessRuntimeStore(tdb.db);
});

afterAll(() => tdb.close());

const ref = { userId: "user-1", conversationId: "conv-1" };
const empty = { sandboxId: null, harnessResumeState: null };
const state = (n: number): HarnessAgentResumeSessionState =>
	({ type: "resume-session", data: { turn: n } }) as never;

it("round-trips both pointers verbatim on one runtime row, each save leaving the other intact", async () => {
	expect(await store.load(ref)).toEqual(empty);
	// Either pointer creates the row; neither overwrites the other.
	await store.save(ref, { sandboxId: "sbx-1" });
	expect(await store.load(ref)).toEqual({ ...empty, sandboxId: "sbx-1" });
	await store.save(ref, { harnessResumeState: state(1) });
	expect(await store.load(ref)).toEqual({
		sandboxId: "sbx-1",
		harnessResumeState: state(1),
	});
	// A later turn replaces each pointer on the existing row.
	await store.save(ref, { harnessResumeState: state(2) });
	await store.save(ref, { sandboxId: "sbx-2" });
	expect(await store.load(ref)).toEqual({
		sandboxId: "sbx-2",
		harnessResumeState: state(2),
	});
	// One row, and the Run path's columns are never touched: no taint write.
	const rows = await tdb.db.select().from(conversationRuntime);
	expect(rows).toHaveLength(1);
	expect(rows[0]).toMatchObject({
		sandboxTainted: false,
		agentSessionId: null,
	});
	expect(
		await store.load({ userId: "user-2", conversationId: "conv-1" }),
	).toEqual(empty);
});
