-- Local compose only. Provisions chat-api's writable database on the shared
-- postgres instance, kept separate from the gateway's read-only KB (mymemo_kb).
-- The Postgres entrypoint runs this once, on first init, connected to the
-- default database. Production provisions mymemo_agent + a scoped writable role
-- out of band; this file is the dev convenience equivalent.
--
-- The table DDL mirrors apps/chat-api/db/schema.sql (the canonical app schema) —
-- keep the two in sync.

CREATE DATABASE mymemo_agent;

\connect mymemo_agent

CREATE TABLE IF NOT EXISTS sandbox_leases (
	user_id          TEXT        NOT NULL,
	conversation_id  TEXT        NOT NULL,
	sandbox_id       TEXT        NOT NULL,
	agent_session_id TEXT,
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, conversation_id)
);
