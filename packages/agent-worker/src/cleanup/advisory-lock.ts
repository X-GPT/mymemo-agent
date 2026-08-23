/**
 * Single-flighting for the cleanup pass owned by `agent-maintenance`.
 * Production runs one service task; the advisory lock also prevents overlapping
 * passes during rollouts or duplicate starts. This is an optimization, not a
 * correctness requirement, because the pass's E2B operations are idempotent.
 */

/** The minimal pooled-connection surface the lock needs; `pg.Pool` satisfies it. */
export interface AdvisoryLockPool {
	connect(): Promise<AdvisoryLockClient>;
}

export interface AdvisoryLockClient {
	query(
		text: string,
		params?: unknown[],
	): Promise<{ rows: Array<Record<string, unknown>> }>;
	/** Return the connection to the pool. */
	release(): void;
}

/**
 * Fixed 63-bit key for the cleanup advisory lock (ASCII "mymclean"-derived);
 * every process must use the same value or they would not exclude each other.
 */
export const CLEANUP_ADVISORY_LOCK_KEY = 8_242_869_154_306_402;

/**
 * Run `fn` iff this process can take the session advisory lock for `key`. The
 * lock is acquired and released on ONE dedicated pooled connection — a
 * session-scoped `pg_try_advisory_lock` bound to a different backend than its
 * `pg_advisory_unlock` would never release. The connection is held idle (not in
 * a transaction) for the pass duration, so E2B HTTP calls in `fn` never sit
 * inside an open transaction. Returns `{ ran: false }` when another replica
 * holds the lock.
 */
export async function tryWithAdvisoryLock<T>(
	pool: AdvisoryLockPool,
	key: number,
	fn: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
	const client = await pool.connect();
	try {
		const acquired = await client.query(
			"select pg_try_advisory_lock($1) as locked",
			[key],
		);
		if (acquired.rows[0]?.locked !== true) return { ran: false };
		try {
			return { ran: true, result: await fn() };
		} finally {
			await client.query("select pg_advisory_unlock($1)", [key]);
		}
	} finally {
		client.release();
	}
}
