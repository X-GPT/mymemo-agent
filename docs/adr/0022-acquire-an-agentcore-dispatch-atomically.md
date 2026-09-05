# Acquire an AgentCore dispatch atomically

Status: accepted

Superseded (2026-09-05) by [ADR-0035](./0035-serve-chat-through-a-lambda-front-and-a-code-interpreter-hand.md): atomic dispatch acquisition retires at the v1 cutover.

Amended (2026-08-16) by
[ADR-0025](./0025-select-the-execution-runtime-at-conversation-creation.md):
the execution-lane validation is removed with the lane itself, and the
transaction additionally asserts the dispatched Run is the Conversation's
oldest Active Run, making explicit the depth-one admission bound this contract
has always relied on. Everything else — the lock order, epoch and lease
establishment, `queued` to `running` in one transaction, and the disposition
matrix — is unchanged.

An AgentCore invocation will acquire its exact dispatched Run in one
transaction that locks the Conversation before the Run, validates its immutable
AgentCore execution lane, establishes a new Conversation Ownership epoch and
lease, and transitions that Run from `queued` to `running`. Claim and start are
not separate operations: a crash between them would leave an owned Conversation
without the Durable acquisition required to acknowledge SQS.

The transaction returns a typed Dispatch disposition. A live exact acquisition
and an already-terminal exact Run may be acknowledged; queued contention or an
expired holder awaiting Reclamation retries; identity, lane, or Runtime-session
mismatch is poison work and alarms. Existing epoch-fenced renewal, Run-event,
runtime, transcript, artifact, terminal, release, and Reclamation helpers remain
the only write and recovery authority.

## Considered options

- **Call the existing global Claim and then start the requested Run.** Rejected
  because global Claim may select unrelated work and leaves a crash boundary
  before Run start.
- **Give AgentCore a Run-scoped lease.** Rejected because it would conflict with
  the Conversation-scoped authority shared by Workspace, Agent session,
  artifacts, and every other execution write.
- **Retry a Run after expired ownership.** Rejected because a MyMemo Run
  executes at most once; Reclamation establishes its error Outcome instead.
