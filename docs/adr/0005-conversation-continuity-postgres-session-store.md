# Conversation continuity via SDK SessionStore backed by Postgres

Status: accepted

In the split runtime the Claude Agent SDK runs in Fargate workers, its
session transcripts are worker-local disk files, and a conversation is not
pinned to a worker — so the prototype's implicit continuity story (SDK
session files living on the per-conversation sandbox filesystem) silently
broke. We restore continuity with the SDK's documented `SessionStore`
adapter interface backed by the writable agent Postgres
(`AGENT_DATABASE_URL`): the SDK mirrors transcript entries to Postgres
during each run, and the next run — on any worker — resumes with
`{ sessionStore, resume: agentSessionId }`, where `agentSessionId` is the
per-conversation resume pointer stored in `conversation_runtime`.

## Considered Options

- **Stash SDK session files in the E2B sandbox** (it persists
  per-conversation) — rejected: the transcript would become sandbox-writable
  state fed back as trusted model context, giving prompt-injected code a
  persistent cross-turn context-poisoning and system-prompt-exfiltration
  vector. The split exists to prevent exactly this.
- **Pin conversations to workers** — rejected: contradicts the claim model
  and breaks scale-in and crash recovery.
- **Reconstruct history from `run_events` each turn** — rejected: lossy
  (drops tool-call context), re-implements what the SDK's documented
  `SessionStore` interface (with a Postgres reference adapter and
  conformance suite) already provides.
- **SDK `SessionStore` on Postgres** (chosen).

## Consequences

- `conversation_runtime` regains `agent_session_id` as the resume pointer.
  It advances only in the run's terminal-success transition, under the same
  ownership fence as other runtime metadata — a stale worker cannot move it.
  Stale-worker transcript appends land under that worker's own session key
  and are harmless orphans.
- Mirror writes are best-effort: if any `mirror_error` occurred during a
  run, the pointer does not advance. The run still succeeds for the user;
  the next turn resumes from the previous session and loses only that
  turn's model-side memory (the user-visible history in `run_events` is
  unaffected).
- Retention is ours: conversation deletion must delete the conversation's
  transcripts from the session store; superseded session transcripts are
  cleaned up by the same periodic cleanup that owns snapshots.
- The worker must run each query with a deterministic, conversation-stable
  working directory so the store's `projectKey` is identical across workers
  and turns.
