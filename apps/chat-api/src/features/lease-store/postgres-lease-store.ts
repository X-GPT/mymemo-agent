import { and, eq, isNull, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { sandboxLeases } from "@/db/schema";
import type {
	LeaseClaim,
	LeaseRecord,
	LeaseRef,
	LeaseStore,
} from "./lease-store";

/**
 * Drizzle adapter for {@link LeaseStore}, over the `sandbox_leases` table. The
 * composite primary key `(user_id, conversation_id)` makes per-user /
 * per-conversation isolation a database invariant. All concurrency control is
 * plain atomic SQL — no advisory locks, no reserved connections — so it runs on
 * the shared pool and is exercised end-to-end by the pglite-backed tests.
 *
 * Lease deadlines are computed DB-side from `now()` so every replica compares
 * against one clock (no cross-host skew).
 */
export class PostgresLeaseStore implements LeaseStore {
	constructor(private readonly db: Database) {}

	async claimLease(
		ref: LeaseRef,
		ownerId: string,
		ttlMs: number,
	): Promise<LeaseClaim | null> {
		// Atomic CAS: insert the row if absent, else take it over ONLY when it is
		// free (owner_id IS NULL) or its lease has expired. When another owner holds
		// an unexpired lease the `setWhere` fails, the upsert touches no row, and
		// `returning` is empty → null → caller treats it as busy.
		const rows = await this.db
			.insert(sandboxLeases)
			.values({
				userId: ref.userId,
				conversationId: ref.conversationId,
				ownerId,
				fencingToken: 1,
				leaseExpiresAt: expiresAt(ttlMs),
				updatedAt: sql`now()`,
			})
			.onConflictDoUpdate({
				target: [sandboxLeases.userId, sandboxLeases.conversationId],
				set: {
					ownerId,
					fencingToken: sql`${sandboxLeases.fencingToken} + 1`,
					leaseExpiresAt: expiresAt(ttlMs),
					updatedAt: sql`now()`,
				},
				setWhere: or(
					isNull(sandboxLeases.ownerId),
					lt(sandboxLeases.leaseExpiresAt, sql`now()`),
				),
			})
			.returning({
				fencingToken: sandboxLeases.fencingToken,
				sandboxId: sandboxLeases.sandboxId,
				agentSessionId: sandboxLeases.agentSessionId,
			});
		return rows[0] ?? null;
	}

	async renewLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
		ttlMs: number,
	): Promise<boolean> {
		const rows = await this.db
			.update(sandboxLeases)
			.set({ leaseExpiresAt: expiresAt(ttlMs), updatedAt: sql`now()` })
			.where(ownedBy(ref, ownerId, fencingToken))
			.returning({ conversationId: sandboxLeases.conversationId });
		return rows.length > 0;
	}

	async releaseLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
		pointer: { sandboxId: string; agentSessionId: string | null },
	): Promise<void> {
		// Clear ownership (the sandbox stays warm, unowned) and persist the pointer.
		// The owner+token guard means a hold stolen mid-turn writes nothing.
		await this.db
			.update(sandboxLeases)
			.set({
				ownerId: null,
				leaseExpiresAt: null,
				sandboxId: pointer.sandboxId,
				agentSessionId: pointer.agentSessionId,
				updatedAt: sql`now()`,
			})
			.where(ownedBy(ref, ownerId, fencingToken));
	}

	async dropLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
	): Promise<void> {
		await this.db.delete(sandboxLeases).where(ownedBy(ref, ownerId, fencingToken));
	}

	async get(ref: LeaseRef): Promise<LeaseRecord | null> {
		const rows = await this.db
			.select({
				userId: sandboxLeases.userId,
				conversationId: sandboxLeases.conversationId,
				sandboxId: sandboxLeases.sandboxId,
				agentSessionId: sandboxLeases.agentSessionId,
			})
			.from(sandboxLeases)
			.where(
				and(
					eq(sandboxLeases.userId, ref.userId),
					eq(sandboxLeases.conversationId, ref.conversationId),
				),
			)
			.limit(1);
		return rows[0] ?? null;
	}

	async delete(ref: LeaseRef): Promise<void> {
		await this.db
			.delete(sandboxLeases)
			.where(
				and(
					eq(sandboxLeases.userId, ref.userId),
					eq(sandboxLeases.conversationId, ref.conversationId),
				),
			);
	}
}

/** DB-side lease deadline `now() + ttlMs`, so all replicas use one clock. */
function expiresAt(ttlMs: number) {
	return sql`now() + make_interval(secs => ${ttlMs / 1000})`;
}

/** Match the row only if this exact hold (`ownerId` + `fencingToken`) owns it. */
function ownedBy(ref: LeaseRef, ownerId: string, fencingToken: number) {
	return and(
		eq(sandboxLeases.userId, ref.userId),
		eq(sandboxLeases.conversationId, ref.conversationId),
		eq(sandboxLeases.ownerId, ownerId),
		eq(sandboxLeases.fencingToken, fencingToken),
	);
}
