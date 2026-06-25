import { and, eq, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { sandboxLeases } from "@/db/schema";
import type { LeaseRecord, LeaseRef, LeaseStore } from "./lease-store";

/**
 * Drizzle adapter for {@link LeaseStore}, over the `sandbox_leases` table. The
 * composite primary key `(user_id, conversation_id)` is what makes isolation a
 * database invariant — two users, or two conversations, can never resolve to the
 * same row, so they can never share a leased sandbox.
 *
 * Column ↔ field mapping lives in the Drizzle schema, so the rest of the app
 * speaks camelCase and never touches column names.
 */
export class PostgresLeaseStore implements LeaseStore {
	constructor(private readonly db: Database) {}

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

	async upsert(record: LeaseRecord): Promise<void> {
		// One row per conversation: a fresh sandbox replaces the stale pointer
		// rather than accumulating rows. `updated_at` is bumped (DB-side `now()`)
		// so the idle reaper (Task 14) can age leases out. The daemon endpoint is
		// deliberately not stored — only id + session.
		await this.db
			.insert(sandboxLeases)
			.values({
				userId: record.userId,
				conversationId: record.conversationId,
				sandboxId: record.sandboxId,
				agentSessionId: record.agentSessionId,
			})
			.onConflictDoUpdate({
				target: [sandboxLeases.userId, sandboxLeases.conversationId],
				set: {
					sandboxId: record.sandboxId,
					agentSessionId: record.agentSessionId,
					updatedAt: sql`now()`,
				},
			});
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

	async withClaim<T>(
		ref: LeaseRef,
		fn: () => Promise<T>,
	): Promise<{ acquired: boolean; result?: T }> {
		// A non-blocking session-level advisory lock keyed by the conversation:
		// lock + unlock must run on one connection, so reserve one from the shared
		// Bun SQL pool for the duration of `fn`. Session-scoped, so Postgres
		// auto-releases on a dropped connection (crash) — no TTL/stale sweep. Two
		// int4 keys (one per id half) so the lock is keyed by the conversation; a
		// hash collision only makes two unrelated conversations occasionally
		// serialize — never a correctness problem.
		const key1 = hashKey(ref.userId);
		const key2 = hashKey(ref.conversationId);
		const reserved = await this.db.$client.reserve();
		try {
			const rows = (await reserved`SELECT pg_try_advisory_lock(${key1}, ${key2}) AS locked`) as Array<{
				locked: boolean;
			}>;
			if (!rows[0]?.locked) return { acquired: false };
			try {
				return { acquired: true, result: await fn() };
			} finally {
				await reserved`SELECT pg_advisory_unlock(${key1}, ${key2})`;
			}
		} finally {
			reserved.release();
		}
	}
}

/**
 * Deterministic 32-bit FNV-1a hash folded into the signed int4 range that
 * `pg_advisory_lock` keys use. Stable across processes, so every replica maps a
 * given id to the same lock key.
 */
function hashKey(value: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}
