# Share Run serving without sharing runtime control loops

Status: accepted

Superseded (2026-09-05) by [ADR-0035](./0035-serve-chat-through-a-lambda-front-and-a-code-interpreter-hand.md): shared Run serving retires at the v1 cutover.

Amended (2026-08-22) by
[ADR-0031](./0031-make-agentcore-the-sole-execution-runtime.md) and the Fargate
retirement: the coexistence-specific control-loop decision below is superseded.
AgentCore Durable acquisition now owns one exact dispatched Run, and the
always-on `agent-maintenance` service solely owns expiration, Reclamation, and
cleanup. Fargate Claims, doorbells, snapshot draining, and Run serving no
longer exist. With AgentCore Runtime as the sole Run-serving caller, the
implementation is local to `apps/agentcore-runtime`; no compatibility package
or shared serving seam remains.

Historical amendment (2026-08-16) by
[ADR-0025](./0025-select-the-execution-runtime-at-conversation-creation.md):
the execution lane becomes the execution runtime and the canary qualifiers
drop — the one-execution-per-process registry is the production AgentCore
posture, because one session process serves one Conversation, and the
ten-minute queued backstop is the `agentcore` timeout. During coexistence,
Fargate remained the single global Reclamation runner; re-homing it was out of
scope until Fargate retirement was decided.

## Original coexistence decision

Fargate and AgentCore shared one `serveStartedRun` behavior for lease
renewal, interruption observation, Live Stream production, SDK and Tool work,
terminalization, and abort reconciliation. Fargate kept its global queue
control loop, snapshot drain, lane-filtered Claim, and release; an AgentCore
invocation atomically acquires one exact Run, serves it once, and releases. This
kept Run semantics identical without starting a global claimant or sweeper per
HTTP invocation.

The always-on Fargate loop remained the single global Reclamation runner and
could reclaim expired Ownership from either execution lane. Fargate claimable
counts, doorbells, and Claims filtered to Fargate, while the shared queued
backstop used a 60-second Fargate timeout and a ten-minute AgentCore-canary
timeout. AgentCore request handlers did not run global expiration or
Reclamation.

An AgentCore handler emits its Acquisition receipt after commit but remains
alive until shared Run serving ends. Response-stream cancellation does not abort
the Run; only durable interruption, ownership loss, Runtime shutdown, mirror
failure, or sandbox-renewal failure does. A process-level registry bounds the
canary to one active execution and keeps `/ping` at `HealthyBusy` until that
execution actually ends.

## Considered options

- **Run the existing `RunLoop` per invocation.** Rejected because every request
  would globally claim and sweep work, multiply concurrency limits, and own an
  independent shutdown lifecycle.
- **Copy the Run execution path into the AgentCore adapter.** Rejected because
  interruption, fencing, transcript, artifact, and Live Stream semantics would
  drift between runtimes.
- **Add an AgentCore-specific reaper.** Rejected because Reclamation protects
  shared Conversation Ownership and must remain one durable authority.
