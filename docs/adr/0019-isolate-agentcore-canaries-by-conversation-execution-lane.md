# Isolate AgentCore canaries by Conversation execution lane

Status: superseded by
[ADR-0025](./0025-select-the-execution-runtime-at-conversation-creation.md)
(2026-08-16)

Superseded outright: the execution lane's subject — isolating an
operator-created canary from user traffic — ceases to exist with the canary
control plane. The per-Conversation immutability rationale survives as
ADR-0025's execution runtime, selected by gate at Conversation creation.

MyMemo will introduce an immutable execution lane on each Conversation, with
all existing and public creation paths defaulting to Fargate and only the
operator canary path able to create an AgentCore-canary Conversation. Claims
and dispatch are lane-aware, but Postgres Conversation Ownership and its epoch
fence remain the single execution authority. This prevents Fargate from taking
synthetic AgentCore work and prevents an AgentCore invocation from draining
unrelated user work without splitting Run state into a second database or
weakening the Conversation-scoped ownership model.

## Considered options

- **Target individual Runs.** Rejected because execution ownership, Workspace,
  Agent session, and artifacts are Conversation-scoped; mixed-runtime Runs
  would create a second authority boundary inside one Conversation.
- **Use an advisory routing hint.** Rejected because either runtime could still
  execute the wrong work when dispatch is duplicated or delayed.
- **Use a separate canary database.** Rejected because it would not validate
  production ownership, dispatch, TLS, recovery, and secret wiring.

## Consequences

- Ordinary Run admission never creates AgentCore dispatch work. Only admission
  against an operator-created AgentCore-canary Conversation does so, atomically
  with the admitted Run.
- The AgentCore entrypoint acquires only the specifically dispatched
  Conversation and Run; it never starts the generic global drain loop.
- The canary uses production infrastructure with a dedicated synthetic
  identity and synthetic collection, while real-user routing remains Fargate.
- Deployment is ordered: add the default-Fargate lane, deploy and verify the
  lane-aware Fargate claimant on every task, and only then install authority to
  create an AgentCore-canary Conversation.
- A lane-unaware Fargate binary cannot be restored while any AgentCore-canary
  Conversation exists. Incident rollback first disables dispatch, completes
  canary cleanup, and proves the database contains only Fargate Conversations;
  the additive lane schema remains in place.
