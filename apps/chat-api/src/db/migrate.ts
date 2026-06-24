import { join } from "node:path";
import { drizzle } from "drizzle-orm/bun-sql";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { resolveDatabaseUrl } from "@/config/env";

/**
 * Standalone migration runner for the writable DB (`mymemo_agent`). Run
 * out-of-band in deploy/CI (or once locally after the DB is up) rather than on
 * every app boot, so multiple chat-api replicas never race to migrate. Applies
 * every pending migration under `drizzle/`. Resolves the connection string the
 * same way the app does (DB_PASSWORD splice + DB_SSL) so both connect identically.
 */
const databaseUrl = resolveDatabaseUrl(
	Bun.env.DATABASE_URL,
	Bun.env.DB_PASSWORD,
	Bun.env.DB_SSL,
);
if (!databaseUrl) {
	console.error("DATABASE_URL is required to run migrations");
	process.exit(1);
}

const db = drizzle(databaseUrl);
await migrate(db, { migrationsFolder: join(import.meta.dir, "../../drizzle") });
console.log("migrations applied");
process.exit(0);
