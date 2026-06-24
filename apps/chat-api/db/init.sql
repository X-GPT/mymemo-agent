-- Local compose only. Provisions chat-api's writable database on the shared
-- postgres instance, kept separate from the gateway's read-only KB (mymemo_kb).
-- The Postgres entrypoint runs this once, on first init, connected to the
-- default database. Production provisions mymemo_agent + a scoped writable role
-- out of band; this file is the dev convenience equivalent.
--
-- Table DDL is NOT here: the writable schema is owned by Drizzle migrations
-- (src/db/schema.ts -> drizzle/). Create the database with this file, then apply
-- the schema with `bun run db:migrate` (DATABASE_URL pointed at mymemo_agent).

CREATE DATABASE mymemo_agent;
