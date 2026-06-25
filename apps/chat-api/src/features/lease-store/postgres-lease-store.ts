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
}
