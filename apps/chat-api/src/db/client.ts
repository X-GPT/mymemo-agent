import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/**
 * The Drizzle client over chat-api's own writable Postgres (`mymemo_agent`),
 * backed by Bun's built-in SQL driver (pooled). This is the single data-access
 * seam for the writable DB; stores receive a `Database` and never open their own
 * connection. The gateway's read-only KB is a separate connection and is not
 * Drizzle-managed.
 */
export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseUrl: string) {
	return drizzle({
		connection: { url: databaseUrl, max: 8 },
		schema,
	});
}
