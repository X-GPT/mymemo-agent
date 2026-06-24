import type { Db } from "./db";
import type { LeaseRecord, LeaseRef, LeaseStore } from "./lease-store";

/**
 * Postgres adapter for {@link LeaseStore}, over the `sandbox_leases` table
 * (see `db/schema.sql`). The primary key `(user_id, conversation_id)` is what
 * makes isolation a database invariant — two users, or two conversations, can
 * never resolve to the same row, so they can never share a leased sandbox.
 *
 * All SQL is parameterized; the row shape is mapped to/from `LeaseRecord` here so
 * the rest of the app speaks camelCase and never touches column names.
 */
export class PostgresLeaseStore implements LeaseStore {
	constructor(private readonly db: Db) {}

	async get(ref: LeaseRef): Promise<LeaseRecord | null> {
		const rows = await this.db.query<LeaseRow>(
			`SELECT user_id, conversation_id, sandbox_id, agent_session_id
			   FROM sandbox_leases
			  WHERE user_id = $1 AND conversation_id = $2`,
			[ref.userId, ref.conversationId],
		);
		const row = rows[0];
		return row ? rowToRecord(row) : null;
	}

	async upsert(record: LeaseRecord): Promise<void> {
		// One row per conversation: a fresh sandbox replaces the stale pointer
		// rather than accumulating rows. `updated_at` is bumped so the idle reaper
		// (Task 14) can age leases out.
		await this.db.query(
			`INSERT INTO sandbox_leases
			   (user_id, conversation_id, sandbox_id, agent_session_id, updated_at)
			 VALUES ($1, $2, $3, $4, now())
			 ON CONFLICT (user_id, conversation_id) DO UPDATE SET
			   sandbox_id = EXCLUDED.sandbox_id,
			   agent_session_id = EXCLUDED.agent_session_id,
			   updated_at = now()`,
			[
				record.userId,
				record.conversationId,
				record.sandboxId,
				record.agentSessionId,
			],
		);
	}

	async delete(ref: LeaseRef): Promise<void> {
		await this.db.query(
			`DELETE FROM sandbox_leases WHERE user_id = $1 AND conversation_id = $2`,
			[ref.userId, ref.conversationId],
		);
	}
}

/** Raw `sandbox_leases` row as returned by the driver (snake_case columns). */
interface LeaseRow {
	user_id: string;
	conversation_id: string;
	sandbox_id: string;
	agent_session_id: string | null;
}

function rowToRecord(row: LeaseRow): LeaseRecord {
	return {
		userId: row.user_id,
		conversationId: row.conversation_id,
		sandboxId: row.sandbox_id,
		agentSessionId: row.agent_session_id,
	};
}
