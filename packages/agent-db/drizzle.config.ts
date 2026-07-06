import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the writable agent DB (`mymemo_agent`). `src/schema.ts`
 * is the source of truth; `bun run db:generate` emits SQL migrations into
 * `drizzle/`, which chat-api's `db:migrate` runner applies and every app's
 * PGlite test harness replays. `AGENT_DATABASE_URL` is only read by drizzle-kit's
 * introspection/push commands, not by `generate`.
 */
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/schema.ts",
	out: "./drizzle",
	dbCredentials: { url: process.env.AGENT_DATABASE_URL ?? "" },
});
