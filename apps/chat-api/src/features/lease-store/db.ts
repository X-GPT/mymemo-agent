import { SQL } from "bun";

/**
 * Minimal data-access seam, mirroring the gateway's `Db`. Parameterized SQL
 * only, so the lease store's query logic is unit-tested with a fake `Db` and
 * never needs a live Postgres. chat-api owns its own writable database
 * (`mymemo_agent`) — distinct from the gateway's read-only KB connection.
 */
export interface Db {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
}

/** The real `Db`, backed by Bun's built-in Postgres client (pooled). */
export function createDb(databaseUrl: string): Db {
	const sql = new SQL({ url: databaseUrl, max: 8 });
	return {
		query: <T>(text: string, params: unknown[] = []) =>
			sql.unsafe(text, params) as Promise<T[]>,
	};
}
