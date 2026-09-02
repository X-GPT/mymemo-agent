import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { conversations, conversationVm } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { sql } from "drizzle-orm";
import { PostgresConversationVmStore } from "./postgres-conversation-vm-store";

const ref = { userId: "member-1", conversationId: "conversation-1" };
const vm = {
	microvmId: "microvm-1",
	endpoint: "vm-1.example",
	imageVersion: "3",
};

let tdb: TestDb;
let store: PostgresConversationVmStore;

beforeAll(async () => {
	tdb = await createTestDatabase();
	store = new PostgresConversationVmStore(tdb.db);
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({ ...ref, scope: "general" });
});

async function row() {
	const [found] = await tdb.db.select().from(conversationVm);
	return found;
}

/** Claim, asserting this caller won; returns the claim token. */
async function claim(): Promise<string> {
	const result = await store.claimLaunch(ref);
	if (typeof result !== "string") throw new Error("expected to win the claim");
	return result;
}

async function ageClaim() {
	await tdb.db
		.update(conversationVm)
		.set({ lastActivityAt: sql`now() - interval '3 minutes'` });
}

describe("PostgresConversationVmStore — the transactional launch claim", () => {
	it("claims a fresh Conversation once; the second claimant sees the launching row", async () => {
		await claim();
		expect(await store.claimLaunch(ref)).toMatchObject({
			state: "launching",
			microvmId: null,
		});
	});

	it("records the launch as running and hands later claimants the VM", async () => {
		const token = await claim();
		expect(await store.recordLaunched(ref, token, vm)).toBe(true);
		expect(await store.claimLaunch(ref)).toMatchObject({
			state: "running",
			...vm,
		});
		expect((await row())?.claimToken).toBeNull();
	});

	it("re-claims a terminated row (rehydrate) and clears the old VM", async () => {
		await store.recordLaunched(ref, await claim(), vm);
		await store.markTerminated(ref, { microvmId: vm.microvmId });
		expect((await row())?.state).toBe("terminated");
		await claim();
		expect(await row()).toMatchObject({
			state: "launching",
			microvmId: null,
			endpoint: null,
			imageVersion: null,
		});
	});

	it("re-claims a stale launching claim but not a fresh one", async () => {
		await claim();
		expect(typeof (await store.claimLaunch(ref))).not.toBe("string");
		await ageClaim();
		await claim();
		// The re-claim is a fresh claim: the next caller waits again.
		expect(typeof (await store.claimLaunch(ref))).not.toBe("string");
	});

	it("fences record and release on the claim token: a superseded launcher cannot touch the newer claim", async () => {
		const stale = await claim();
		await ageClaim();
		const fresh = await claim();

		expect(await store.recordLaunched(ref, stale, vm)).toBe(false);
		await store.releaseClaim(ref, stale);
		expect(await row()).toMatchObject({
			state: "launching",
			claimToken: fresh,
			microvmId: null,
		});

		expect(
			await store.recordLaunched(ref, fresh, { ...vm, microvmId: "microvm-2" }),
		).toBe(true);
		expect(await row()).toMatchObject({
			state: "running",
			microvmId: "microvm-2",
		});
	});

	it("releaseClaim hands a failed launch back immediately", async () => {
		await store.releaseClaim(ref, await claim());
		expect((await row())?.state).toBe("terminated");
		await claim();
	});

	it("markTerminated is guarded on the VM id, so a newer VM survives a stale report", async () => {
		await store.recordLaunched(ref, await claim(), vm);
		await store.markTerminated(ref, { microvmId: "microvm-old" });
		expect((await row())?.state).toBe("running");
	});

	it("rejects a claim for a Conversation that does not exist", async () => {
		await expect(
			store.claimLaunch({ ...ref, conversationId: "missing" }),
		).rejects.toThrow();
	});
});
