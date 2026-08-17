# Select the execution runtime at Conversation creation

Status: accepted (2026-08-16). Supersedes ADR-0019, ADR-0021, and ADR-0024.
Amended (2026-08-17) by
[ADR-0027](./0027-deploy-the-agentcore-dispatch-publisher-as-a-dedicated-service.md).

Every Conversation carries an immutable execution runtime — `fargate` or
`agentcore` — selected exactly once at creation by a server-side Statsig gate
evaluated on the trusted identity after the existing exposure gate allows the
request. A gate error, Statsig unavailability, or break-glass mode selects
`fargate`: the runtime gate fails safe to the proven runtime rather than
failing closed, because refusing Conversation creation would protect nothing.
No later surface re-evaluates the selection, and disabling the gate stops only
new `agentcore` Conversations. There is no separate canary system: the
AgentCore path is the normal production path, verified after a deploy by an
ordinary synthetic Conversation driven through the real chat-api surface, not
by an operator-only creation path.

Run admission on an `agentcore` Conversation writes the dispatch outbox record
in the same transaction, each admitted Run produces exactly one dispatch, and
an AgentCore invocation serves exactly that Run — it holds no authority to
drain other work. This is sound because admission bounds Active Runs at depth
one, so a second admitted Run cannot exist while one is active; Durable
acquisition additionally asserts the dispatched Run is the Conversation's
oldest Active Run, so raising the admission depth later fails loudly instead
of corrupting ordering. The queue remains standard SQS: ordering, deduplication,
and recovery live in Postgres Conversation Ownership and Run state, exactly as
ADR-0020 records.

This decision covers coexistence, not replacement. Fargate remains the default
runtime and the single global expiration and Reclamation runner; retiring
Fargate — re-homing Reclamation and the pull loop — is explicitly out of scope
and undecided. The Dispatch publisher is independently homed by ADR-0027, so
Fargate retirement does not move it. The fail-closed SSM dispatch parameter
survives, renamed, as the dispatch-layer kill switch: the gate stops new
`agentcore` Conversations, while the parameter stops delivery for existing
ones, whose queued Runs then error at the queued backstop timeout. Runtime
immutability has one documented break-glass exception: with dispatch disabled,
zero Active Runs, and no pending dispatch rows, an operator runbook step may
reassign stranded `agentcore` Conversations to `fargate` — safe because every
durable resource (transcript, Workspace, artifacts) is runtime-agnostic by
construction.

## Considered options

- **Keep the canary control plane and certify before rollout.** Rejected
  because there is no user traffic to protect and no evidence AgentCore needs a
  separate campaign to prove boot or dependency access. The Campaign, Step
  Functions orchestration, and scenario suite were disposable machinery for
  what the normal path plus a post-deploy smoke proves directly.
- **Re-evaluate the gate per turn, or allow runtime switching.** Rejected
  because Workspace, Agent session, artifacts, Ownership, and sequential
  execution are Conversation-scoped; switching runtimes mid-life recreates the
  mixed-authority boundary ADR-0019 refused. That rationale survives even as
  the lane itself retires.
- **Conversation-grained dispatch with drain authority.** Rejected because with
  Active Runs bounded at depth one, per-Run and per-Conversation dispatch
  coincide; drain machinery in the Runtime would serve a queue depth that
  cannot occur and would weaken ADR-0023's boundary.
- **Fail the runtime gate closed.** Rejected because blocking Conversation
  creation on Statsig availability converts a routing choice into an outage.
  Fail-closed remains correct for the exposure gate, whose job is refusing new
  work entirely.
- **A separately minted dispatch id.** Rejected because a Run is dispatched at
  most once and never re-dispatched as new work; the exact Run identity is the
  dispatch identity, and replay reuses it.

## Consequences

- ADR-0019 is superseded: the execution lane's subject — isolating an
  operator-created canary from user traffic — ceases to exist. ADR-0024 is
  superseded: campaign orchestration is removed, unbuilt. ADR-0021 is
  superseded: dormancy, campaign NAT windows, typed operator confirmation, and
  the plan-mutation allowlist retire with the canary.
- Re-homed from ADR-0021 as production posture: the digest-pinned ARM64
  request-oriented Runtime image, exact secret ARNs resolved at fresh session
  boot with verified RDS TLS, and per-workload least-privilege roles for
  Runtime, Dispatch publisher, and consumer. ADR-0027 realizes the publisher's
  process, dependency, and AWS-capability boundary as a dedicated service while
  deliberately retaining the shared writable database trust and coordinated
  release train. The Runtime writes Downloadable artifacts in the standard
  production namespace with worker-equivalent upload access; the canary prefix
  dies, because both runtimes serve the same Conversations and their artifact
  keys must be indistinguishable to chat-api's signer.
- The canary-only surfaces are deleted: the control Lambda and preflight, the
  Campaign table, the campaign columns and constraints on the outbox, the
  `agentcore_canary` value, and the campaign-semantic alarms. Canary
  serializers — consumer reserved concurrency of one, the single-scenario
  posture — are lifted; the one-execution-per-process registry remains, as one
  session process serves one Conversation.
- The dispatch contract amendments — envelope version 2, dropped campaign,
  scenario, and lane fields, run identity as dispatch identity, and the
  consumer's pre-invocation Run-status check — are recorded on ADR-0020. The
  publisher's behavioral contract is ADR-0026 and its deployment boundary is
  ADR-0027.
- Cutover is a coordinated rename rather than expand-contract, defensible only
  while there is no real user traffic. The runbook asserts its preconditions
  instead of assuming them: zero `agentcore_canary` Conversations, zero
  Campaign rows, and an empty dispatch queue before the migration runs. The
  deployment-readiness fence survives, renamed: a runtime-unaware Fargate
  binary cannot be restored while any `agentcore` Conversation exists, and the
  rollback runbook — not per-request chat-api code — consults it.
- Deploy order after the schema lands: chat-api with the gate off (everything
  stamps `fargate`), the de-canaried dispatch and Runtime deployed idle, the
  SSM parameter enabled, the operator smoke through a gate-targeted synthetic
  member, then staged gate rollout. Rollback mirrors it: parameter off, gate
  off, then binaries.
- The AG-UI-on-invocation-stream exploration (#462–#467) is out of scope: the
  live transport for `agentcore` Conversations remains the Redis Live Stream
  relay, identical to Fargate.
- The Runtime session identity remains derived — the Conversation UUID — and
  is stored nowhere. AgentCore compute death is handled by lease expiry and
  Reclamation exactly as Fargate worker death; no continuity is lost because
  the transcript and Workspace never live inside AgentCore.
