import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { sandboxLeases } from "@/db/schema";
import { PostgresLeaseStore } from "./postgres-lease-store";
import type { LeaseRef } from "./lease-store";

const ref: LeaseRef = { userId: "user-1", conversationId: "conv-1" };
const TTL = 30_000;

/** Force the row's lease to have expired (simulate a crashed owner). */
async function expireLease(tdb: TestDb, r: LeaseRef) {
	await tdb.db
		.update(sandboxLeases)
		.set({ leaseExpiresAt: sql`now() - make_interval(secs => 60)` })
		.where(
			and(
				eq(sandboxLeases.userId, r.userId),
				eq(sandboxLeases.conversationId, r.conversationId),
			),
		);
}

describe("PostgresLeaseStore", () => {
	let tdb: TestDb;
	let store: PostgresLeaseStore;

	beforeEach(async () => {
		tdb = await createTestDatabase();
		store = new PostgresLeaseStore(tdb.db);
	});
	afterEach(async () => {
		await tdb.close();
	});

	describe("claimLease", () => {
		it("grants a fresh row with token 1 and a null pointer", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			expect(claim).toEqual({
				fencingToken: 1,
				sandboxId: null,
				agentSessionId: null,
			});
		});

		it("rejects a second claim while an owner holds an unexpired lease", async () => {
			await store.claimLease(ref, "owner-A", TTL);
			expect(await store.claimLease(ref, "owner-B", TTL)).toBeNull();
		});

		it("steals an expired lease and bumps the fencing token", async () => {
			await store.claimLease(ref, "owner-A", TTL);
			await expireLease(tdb, ref);

			const stolen = await store.claimLease(ref, "owner-B", TTL);
			expect(stolen?.fencingToken).toBe(2);
		});

		it("returns the persisted warm pointer to the next claimant", async () => {
			const first = await store.claimLease(ref, "owner-A", TTL);
			await store.releaseLease(ref, "owner-A", first?.fencingToken ?? 0, {
				sandboxId: "sbx-1",
				agentSessionId: "sess-1",
			});

			const next = await store.claimLease(ref, "owner-B", TTL);
			expect(next).toEqual({
				fencingToken: 2,
				sandboxId: "sbx-1",
				agentSessionId: "sess-1",
			});
		});

		it("isolates different conversations (independent claims)", async () => {
			const a = await store.claimLease(
				{ userId: "u", conversationId: "c1" },
				"owner-A",
				TTL,
			);
			const b = await store.claimLease(
				{ userId: "u", conversationId: "c2" },
				"owner-B",
				TTL,
			);
			expect(a).not.toBeNull();
			expect(b).not.toBeNull();
		});
	});

	describe("renewLease", () => {
		it("extends the lease for the holding owner+token", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			const held = await store.renewLease(
				ref,
				"owner-A",
				claim?.fencingToken ?? 0,
				TTL,
			);
			expect(held).toBe(true);
		});

		it("returns false for a stale owner or token (hold was lost)", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			const token = claim?.fencingToken ?? 0;
			expect(await store.renewLease(ref, "owner-B", token, TTL)).toBe(false);
			expect(await store.renewLease(ref, "owner-A", token + 1, TTL)).toBe(false);
		});

		it("keeps a held lease unstealable", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			await store.renewLease(ref, "owner-A", claim?.fencingToken ?? 0, TTL);
			expect(await store.claimLease(ref, "owner-B", TTL)).toBeNull();
		});
	});

	describe("releaseLease", () => {
		it("clears ownership, persists the pointer, and frees the conversation", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			await store.releaseLease(ref, "owner-A", claim?.fencingToken ?? 0, {
				sandboxId: "sbx-1",
				agentSessionId: null,
			});

			expect(await store.get(ref)).toMatchObject({ sandboxId: "sbx-1" });
			// Freed: another owner can immediately claim.
			expect(await store.claimLease(ref, "owner-B", TTL)).not.toBeNull();
		});

		it("is a no-op when the hold was stolen (wrong token)", async () => {
			await store.claimLease(ref, "owner-A", TTL); // token 1
			// A stolen hold (token 1) must not clear the current owner's lease.
			await store.releaseLease(ref, "owner-A", 999, {
				sandboxId: "sbx-x",
				agentSessionId: null,
			});
			// Still held by owner-A → a fresh claim is rejected.
			expect(await store.claimLease(ref, "owner-B", TTL)).toBeNull();
		});
	});

	describe("dropLease", () => {
		it("deletes the row for the owning hold so the next turn starts fresh", async () => {
			const claim = await store.claimLease(ref, "owner-A", TTL);
			await store.dropLease(ref, "owner-A", claim?.fencingToken ?? 0);

			expect(await store.get(ref)).toBeNull();
			expect((await store.claimLease(ref, "owner-B", TTL))?.fencingToken).toBe(1);
		});

		it("is a no-op for a stolen hold (wrong token)", async () => {
			await store.claimLease(ref, "owner-A", TTL);
			await store.dropLease(ref, "owner-A", 999);
			expect(await store.get(ref)).not.toBeNull();
		});
	});

	describe("get / delete", () => {
		it("get returns null for an unknown conversation", async () => {
			expect(await store.get(ref)).toBeNull();
		});

		it("delete unconditionally removes the row", async () => {
			await store.claimLease(ref, "owner-A", TTL);
			await store.delete(ref);
			expect(await store.get(ref)).toBeNull();
		});
	});
});
