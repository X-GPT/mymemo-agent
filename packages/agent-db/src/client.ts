import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

/**
 * The Drizzle client over the writable agent Postgres (`mymemo_agent`), backed
 * by node-postgres (`pg`, pooled) — one driver everywhere in the split-runtime
 * services, chosen because the run-event projector needs `LISTEN` connections,
 * which Bun.sql does not implement.
 * Note `pg` treats the resolved URL's `sslmode=require` as verified TLS (server
 * cert checked against the trust store); if RDS verification fails, supply the
 * CA bundle or switch the URL policy to `sslmode=no-verify`.
 * This is the single data-access seam for the writable DB shared by chat-api and
 * agent-worker; stores receive a `Database` and never open their own connection.
 * The worker's read-only KB credential is a separate connection, not Drizzle-managed.
 */
export type Database = ReturnType<typeof createDatabase>;

export function createDatabase(databaseUrl: string) {
	return drizzle({
		connection: { connectionString: databaseUrl, max: 8 },
		schema,
	});
}
