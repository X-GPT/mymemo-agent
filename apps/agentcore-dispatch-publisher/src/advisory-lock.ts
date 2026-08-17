export interface AdvisoryLockPool {
	connect(): Promise<AdvisoryLockClient>;
}

export interface AdvisoryLockClient {
	query(
		text: string,
		params?: unknown[],
	): Promise<{ rows: Array<Record<string, unknown>> }>;
	release(): void;
}

/** Run a callback while one dedicated pool connection owns a session lock. */
export async function tryWithAdvisoryLock<T>(
	pool: AdvisoryLockPool,
	key: number,
	callback: () => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
	const client = await pool.connect();
	try {
		const acquired = await client.query(
			"select pg_try_advisory_lock($1) as locked",
			[key],
		);
		if (acquired.rows[0]?.locked !== true) return { ran: false };
		try {
			return { ran: true, result: await callback() };
		} finally {
			await client.query("select pg_advisory_unlock($1)", [key]);
		}
	} finally {
		client.release();
	}
}
