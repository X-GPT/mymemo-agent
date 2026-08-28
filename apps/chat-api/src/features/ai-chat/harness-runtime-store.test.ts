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
const state = (n: number): HarnessAgentResumeSessionState =>
	({ type: "resume-session", data: { turn: n } }) as never;

it("round-trips both pointers verbatim on one runtime row, each save leaving the other intact", async () => {
	expect(await store.load(ref)).toEqual({ sandboxId: null, resumeState: null });
	// Either pointer creates the row; neither overwrites the other.
	await store.saveSandboxId(ref, "sbx-1");
	expect(await store.load(ref)).toEqual({
		sandboxId: "sbx-1",
		resumeState: null,
	});
	await store.saveResumeState(ref, state(1));
	expect(await store.load(ref)).toEqual({
		sandboxId: "sbx-1",
		resumeState: state(1),
	});
	// A later turn replaces each pointer on the existing row.
	await store.saveResumeState(ref, state(2));
	await store.saveSandboxId(ref, "sbx-2");
	expect(await store.load(ref)).toEqual({
		sandboxId: "sbx-2",
		resumeState: state(2),
	});
	expect(await tdb.db.select().from(conversationRuntime)).toHaveLength(1);
	expect(
		await store.load({ userId: "user-2", conversationId: "conv-1" }),
	).toEqual({ sandboxId: null, resumeState: null });
});
