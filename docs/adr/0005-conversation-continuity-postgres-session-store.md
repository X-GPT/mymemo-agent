# Conversation continuity via SDK SessionStore backed by Postgres

Status: accepted

Amended by
[ADR-0013](./0013-interrupt-runs-without-ending-conversation-continuity.md).

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
  `SessionStore` interface already provides.
- **SDK `SessionStore` on Postgres** (chosen).

## Consequences

- `conversation_runtime.agent_session_id` is the resume pointer. Once
  established, later Runs directly continue under that same session id. A first
  pointer is written only inside an ownership-fenced `done` or `interrupted`
  terminal transaction, after at least one main-session entry was mirrored
  successfully and the bound adapter has not subsequently observed its
  deletion. An SDK delete of that main session withdraws the Run's evidence.
  Recovery never establishes or changes it.
- Every SDK transcript append or delete is atomically fenced by the active Run's
  status, `locked_by`, and unexpired `locked_until`. A stale worker cannot mutate
  the shared session after losing its ownership lease.
- A `mirror_error` is fatal rather than best-effort: it stops model and Tool
  execution and makes a still-running Run end as `error`. A user interruption
  already committed in Postgres still wins and ends as `interrupted`. A mirror
  error cannot establish a first pointer; an existing pointer and any accepted
  transcript tail remain for Claude Code to handle on resume.
- Transcript writes continue directly without staging, per-Run forks, or
  rollback. Rows written before any first pointer is established are inert and
  remain until Conversation deletion, which deletes all of the Conversation's
  session transcripts.
- The worker must run each query with a deterministic, conversation-stable
  working directory so the store's `projectKey` is identical across workers
  and turns.
