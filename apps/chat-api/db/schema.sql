-- chat-api's own writable database (mymemo_agent), distinct from the gateway's
-- read-only KB. Holds operational control-plane state; today, the sandbox-lease
-- registry (MYM-17 / Task 13).
--
-- A lease maps one conversation to the warm sandbox currently serving it. The
-- composite primary key makes per-user / per-conversation isolation a database
-- invariant: two users, or two conversations, can never resolve to one row and
-- therefore can never share a leased sandbox.

-- Only the sandbox *id* is stored. The daemon URL and per-sandbox edge token are
-- recomputed from the reattached handle on reuse, never persisted — that keeps
-- the edge secret out of this store and the endpoint from going stale.
CREATE TABLE IF NOT EXISTS sandbox_leases (
	user_id          TEXT        NOT NULL,
	conversation_id  TEXT        NOT NULL,
	-- The leased sandbox; a reusing process reattaches to it by id.
	sandbox_id       TEXT        NOT NULL,
	-- Claude SDK resume state last threaded into this conversation.
	agent_session_id TEXT,
	created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	-- Bumped on every upsert (each acquire/reuse). The sandbox's own E2B timeout
	-- is what actually reaps an idle sandbox; this lets the Task 14 reaper
	-- proactively sync + drop the row before that expiry.
	updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (user_id, conversation_id)
);
