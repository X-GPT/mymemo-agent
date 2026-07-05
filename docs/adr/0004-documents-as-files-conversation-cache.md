# Materialize loaded documents into a conversation-scoped docs cache

Status: accepted

The original split-runtime draft banned writing KB document content into the
E2B workspace: search snippets and fetched documents were model context only.
We reversed this. Full document content now reaches the agent as files:
`LoadDocuments(documentIds)` runs in the trusted worker (the only holder of
KB credentials), copies scope-checked, size-capped content into a reserved
docs-cache directory in the conversation's sandbox workspace, and returns
metadata only (`path`, `documentId`, `title`). The agent works over the files
with its normal `Read`/`Grep`/`Bash` tools. The driver: file tools are what
an agentic loop is best at, and disk-only delivery keeps document bodies out
of model context, run events, and tool-result persistence entirely.

## Considered Options

- **Documents-as-context** (original design: snippets plus fetch-into-context)
  — rejected: burns context tokens on large documents, poor fit for
  grep/chunked-read workflows, and full bodies returned through tool results
  would persist in `run_events`.
- **Turn-scoped cache** (materialize, delete before end-of-turn checkpoint) —
  rejected: re-copies the same content every turn, which is pure waste for
  `document`-scope conversations that exist to work over one document. KB
  summaries are immutable once created, which removes the staleness argument
  for aggressive expiry.
- **Conversation-scoped cache** (chosen).

## Consequences

- Retention: a KB document copy lives at most as long as the conversation
  that loaded it. The cache persists across turns and rides pause/snapshot as
  a side effect; conversation-deletion cleanup (which kills the sandbox and
  snapshots) is the deletion path. A document deleted (deactivated) in the KB
  keeps its cached copies until the conversations that loaded it are deleted.
- Staleness: user-created documents are editable and are reachable through
  conversation scope, so a cached copy can go stale across turns. V1 accepts
  this; `LoadDocuments` is refresh-on-load (re-loading an id overwrites the
  cached file), and no turn-start revalidation machinery is added.
- The cache never marks the workspace dirty: dirty tracking decides when
  user work needs a checkpoint, and a cache reconstructible from the KB never
  does by itself. A restored sandbox may arrive with an empty or stale cache;
  the agent reloads.
- Any future "agent skill" packaging of search-and-load is prompt-layer
  guidance over these same worker-backed tools. A sandbox-side script cannot
  reach the KB — that would resurrect the token/gateway machinery ADR-0001
  deletes.
