-- chat-api's own writable database (mymemo_agent), distinct from the gateway's
-- read-only KB. Holds operational control-plane state; today, the sandbox-lease
-- registry (MYM-17 / Task 13).
--
-- A lease maps one conversation to the warm sandbox currently serving it. The
-- composite primary key makes per-user / per-conversation isolation a database
-- invariant: two users, or two conversations, can never resolve to one row and
-- therefore can never share a leased sandbox.

CREATE TABLE IF NOT EXISTS sandbox_leases (
	user_id              TEXT        NOT NULL,
	conversation_id      TEXT        NOT NULL,
	-- The leased sandbox; a reusing process reattaches to it by id.
	sandbox_id           TEXT        NOT NULL,
	-- Where the in-sandbox daemon is reachable, plus the per-sandbox edge token
	-- (null for providers with no edge, e.g. the local container).
	daemon_url           TEXT        NOT NULL,
	traffic_access_token TEXT,
	-- Claude SDK resume state last threaded into this conversation.
	agent_session_id     TEXT,
	created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
	-- Bumped on every upsert; the idle reaper (Task 14) ages leases out by this.
	updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, conversation_id)
);
