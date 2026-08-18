export interface AdvisoryLockPool {
	connect(): Promise<AdvisoryLockClient>;
}

export interface AdvisoryLockClient {
	query(
		text: string,
		params?: unknown[],
	): Promise<{ rows: Array<Record<string, unknown>> }>;
	on(event: "error", listener: (error: Error) => void): void;
	off(event: "error", listener: (error: Error) => void): void;
	release(error?: Error | boolean): void;
}

/** Run a callback while one dedicated pool connection owns a session lock. */
export async function tryWithAdvisoryLock<T>(
	pool: AdvisoryLockPool,
	key: number,
	callback: (lockSignal: AbortSignal) => Promise<T>,
): Promise<{ ran: true; result: T } | { ran: false }> {
	const client = await pool.connect();
	const lockSession = new AbortController();
	let clientError: Error | undefined;
	let queryError: Error | boolean | undefined;
	const handleClientError = (error: Error) => {
		clientError ??= error;
		lockSession.abort(error);
	};
	client.on("error", handleClientError);
	try {
		let acquired: { rows: Array<Record<string, unknown>> };
		try {
			acquired = await client.query(
				"select pg_try_advisory_lock($1) as locked",
				[key],
			);
		} catch (error) {
			queryError = error instanceof Error ? error : true;
			throw error;
		}
		if (clientError) throw clientError;
		if (acquired.rows[0]?.locked !== true) return { ran: false };

		let result: T;
		try {
			result = await callback(lockSession.signal);
		} catch (error) {
			if (clientError) throw clientError;
			throw error;
		}
		if (clientError) throw clientError;

		try {
			await client.query("select pg_advisory_unlock($1)", [key]);
		} catch (error) {
			queryError = error instanceof Error ? error : true;
			throw error;
		}
		if (clientError) throw clientError;
		return { ran: true, result };
	} finally {
		try {
			client.release(clientError ?? queryError);
		} finally {
			client.off("error", handleClientError);
		}
	}
}
