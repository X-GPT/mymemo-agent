import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for chat-api's writable DB (`mymemo_agent`). `src/db/schema.ts`
 * is the source of truth; `bun run db:generate` emits SQL migrations into
 * `drizzle/`, and `bun run db:migrate` applies them. `DATABASE_URL` is only read
 * by drizzle-kit's introspection/push commands, not by `generate`.
 */
export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
