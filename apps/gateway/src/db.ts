import { SQL } from "bun";
import { gwEnv } from "./env";

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

let singleton: Db | undefined;

/** The real Db, backed by Bun's built-in Postgres client (lazy, pooled). */
export function getDb(): Db {
	if (singleton) return singleton;
	// TLS is carried in the URL (sslmode); read-only gateway → a small pool.
	const sql = new SQL({ url: gwEnv.DATABASE_URL, max: 8 });
	singleton = {
		query: <T>(text: string, params: unknown[] = []) =>
			sql.unsafe(text, params) as Promise<T[]>,
	};
	return singleton;
}
