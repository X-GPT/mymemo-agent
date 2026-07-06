import { join } from "node:path";

/**
 * Absolute path to the generated SQL migrations for the writable agent DB
 * (`mymemo_agent`). This package owns the schema and its migrations (design:
 * "Drizzle owns schemas and migrations for AGENT_DATABASE_URL"), so both the
 * chat-api `db:migrate` runner and every app's PGlite test harness read the
 * migrations from here rather than from a per-app copy.
 */
export const MIGRATIONS_DIR = join(import.meta.dir, "..", "drizzle");
