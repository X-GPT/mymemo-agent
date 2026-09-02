import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { createDatabase, type Database } from "@mymemo/agent-db/client";
import { conversations } from "@mymemo/agent-db/schema";
import { eq } from "drizzle-orm";
import { PostgresConversationVmStore } from "./postgres-conversation-vm-store";

/**
 * The launch claim race (spec #654, ticket #669) against real PostgreSQL:
 * concurrent POSTs to a VM-less Conversation must yield exactly one launcher.
 * PGlite has one backend, so only this lane can prove it. Runs in CI's
 * `integration` job under `RUN_CHAT_API_POSTGRES_TESTS=true` (the ordinary
 * unit suite's preload sets a placeholder `AGENT_DATABASE_URL`, so the URL
 * alone cannot gate it).
 */

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const RUN = DB_URL !== "" && process.env.RUN_CHAT_API_POSTGRES_TESTS === "true";
const USER_ID = `vm-claim-${crypto.randomUUID()}`;
const ref = { userId: USER_ID, conversationId: "vm-race-conversation" };
const STALE = { staleLaunchAfterMs: 120_000 };

if (RUN) setDefaultTimeout(30_000);

let db: Database;
let store: PostgresConversationVmStore;

describe.skipIf(!RUN)("conversation_vm launch claim under concurrency", () => {
	beforeAll(() => {
		db = createDatabase(DB_URL);
		store = new PostgresConversationVmStore(db);
	});

	afterAll(async () => {
		await db.delete(conversations).where(eq(conversations.userId, USER_ID));
		await db.$client.end();
	});

	beforeEach(async () => {
		await db.delete(conversations).where(eq(conversations.userId, USER_ID));
		await db.insert(conversations).values({ ...ref, scope: "general" });
	});

	it("gives exactly one of many concurrent claimants the launch", async () => {
		const results = await Promise.all(
			Array.from({ length: 12 }, () => store.claimLaunch(ref, STALE)),
		);
		expect(results.filter((r) => r === "claimed")).toHaveLength(1);
		for (const lost of results.filter((r) => r !== "claimed")) {
			expect(lost).toMatchObject({ state: "launching", microvmId: null });
		}
	});

	it("gives exactly one of many concurrent rehydrators the re-claim", async () => {
		await store.claimLaunch(ref, STALE);
		await store.recordLaunched(ref, {
			microvmId: "microvm-old",
			endpoint: "old.example",
			imageVersion: "1",
		});
		await store.markTerminated(ref, { microvmId: "microvm-old" });
		const results = await Promise.all(
			Array.from({ length: 12 }, () => store.claimLaunch(ref, STALE)),
		);
		expect(results.filter((r) => r === "claimed")).toHaveLength(1);
	});
});
