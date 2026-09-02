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

describe("PostgresConversationVmStore — the transactional launch claim", () => {
	it("claims a fresh Conversation once; the second claimant sees the launching row", async () => {
		expect(await store.claimLaunch(ref)).toBe("claimed");
		const second = await store.claimLaunch(ref);
		expect(second).toMatchObject({ state: "launching", microvmId: null });
	});

	it("records the launch as running and hands later claimants the VM", async () => {
		await store.claimLaunch(ref);
		await store.recordLaunched(ref, vm);
		expect(await store.claimLaunch(ref)).toMatchObject({
			state: "running",
			...vm,
		});
	});

	it("re-claims a terminated row (rehydrate) and clears the old VM", async () => {
		await store.claimLaunch(ref);
		await store.recordLaunched(ref, vm);
		await store.markTerminated(ref, { microvmId: vm.microvmId });
		expect((await row())?.state).toBe("terminated");
		expect(await store.claimLaunch(ref)).toBe("claimed");
		expect(await row()).toMatchObject({
			state: "launching",
			microvmId: null,
			endpoint: null,
			imageVersion: null,
		});
	});

	it("re-claims a stale launching claim but not a fresh one", async () => {
		await store.claimLaunch(ref);
		expect(await store.claimLaunch(ref)).not.toBe("claimed");
		await tdb.db
			.update(conversationVm)
			.set({ lastActivityAt: sql`now() - interval '3 minutes'` });
		expect(await store.claimLaunch(ref)).toBe("claimed");
		// The re-claim is a fresh claim: the next caller waits again.
		expect(await store.claimLaunch(ref)).not.toBe("claimed");
	});

	it("releaseClaim hands a failed launch back immediately", async () => {
		await store.claimLaunch(ref);
		await store.releaseClaim(ref);
		expect((await row())?.state).toBe("terminated");
		expect(await store.claimLaunch(ref)).toBe("claimed");
	});

	it("markTerminated is guarded on the VM id, so a newer VM survives a stale report", async () => {
		await store.claimLaunch(ref);
		await store.recordLaunched(ref, vm);
		await store.markTerminated(ref, { microvmId: "microvm-old" });
		expect((await row())?.state).toBe("running");
	});

	it("claimUpgrade wins exactly once for the VM it saw", async () => {
		await store.claimLaunch(ref);
		await store.recordLaunched(ref, vm);
		expect(await store.claimUpgrade(ref, { microvmId: vm.microvmId })).toBe(
			true,
		);
		expect(await row()).toMatchObject({ state: "launching", microvmId: null });
		expect(await store.claimUpgrade(ref, { microvmId: vm.microvmId })).toBe(
			false,
		);
	});

	it("touchActivity stamps a running row only", async () => {
		await store.claimLaunch(ref);
		await tdb.db
			.update(conversationVm)
			.set({ lastActivityAt: sql`now() - interval '3 minutes'` });
		await store.touchActivity(ref);
		const launching = await row();
		expect(
			Date.now() - (launching?.lastActivityAt.getTime() ?? 0),
		).toBeGreaterThan(60_000);
		await store.recordLaunched(ref, vm);
		await tdb.db
			.update(conversationVm)
			.set({ lastActivityAt: sql`now() - interval '3 minutes'` });
		await store.touchActivity(ref);
		const running = await row();
		expect(Date.now() - (running?.lastActivityAt.getTime() ?? 0)).toBeLessThan(
			60_000,
		);
	});

	it("rejects a claim for a Conversation that does not exist", async () => {
		await expect(
			store.claimLaunch({ ...ref, conversationId: "missing" }),
		).rejects.toThrow();
	});
});
