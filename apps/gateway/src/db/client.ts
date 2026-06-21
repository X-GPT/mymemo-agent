import { SQL } from "bun";

/**
 * Minimal data-access seam. Parameterized SQL only — every caller passes a
 * positional-param query, so query logic can be unit-tested with a fake Db and
 * never needs a live Postgres.
 */
export interface Db {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
}

/** The real Db, backed by Bun's built-in Postgres client (pooled). */
export function createDb(databaseUrl: string): Db {
	// TLS is carried in the URL (sslmode); read-only gateway → a small pool.
	const sql = new SQL({ url: databaseUrl, max: 8 });
	return {
		query: <T>(text: string, params: unknown[] = []) =>
			sql.unsafe(text, params) as Promise<T[]>,
	};
}
