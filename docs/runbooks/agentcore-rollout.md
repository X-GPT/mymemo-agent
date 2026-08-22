# AgentCore production operations

AgentCore is the sole production execution runtime. Run admission writes the
transactional Dispatch outbox, the dedicated publisher sends strict envelopes,
and the consumer invokes the Runtime. There is no runtime selector, persisted
discriminator, or fallback.

## Controls

- `mymemo_agent_split_runtime_enabled` is the fail-closed Statsig exposure gate.
  OFF denies new Conversation creation and new non-idempotent Run admission.
- `/mymemo/agentcore-dispatch/<environment>/enabled` is the fail-closed Dispatch
  kill switch. Only the exact value `enabled` permits publication and delivery.

Keep both controls separate: exposure governs new user work; Dispatch governs
delivery of already-admitted outbox rows. Existing-resource reads, reconnect,
history, interruption, artifact access, and exact retries remain available when
exposure is closed.

## Release verification

1. Keep Dispatch disabled when a migration or Runtime compatibility change is
   being applied.
2. Run the normal release so schema migration precedes the consumer, Runtime,
   publisher, and ECS service rollout.
3. Verify one healthy Dispatch publisher and one healthy maintenance task.
4. Verify the Runtime `/ping` contract and image check, then enable Dispatch.
5. Open exposure only after the production smoke creates a Conversation and
   completes a Run with durable history and Live Stream output.

## Incident response

Close exposure first when no new work should enter. Disable Dispatch when the
publisher, consumer, or Runtime must stop receiving queued work. Keep
`agent-maintenance` running: it is the sole owner of queued-Run expiration,
Reclamation after lapsed Ownership, orphan-sandbox cleanup, and artifact cleanup.

Inspect these boundaries in order:

1. unpublished outbox age and publisher advisory-lock/error metrics;
2. SQS age, dead-letter queue depth, and consumer partial-batch failures;
3. Runtime invocation, exact-acquisition, lease, and terminalization logs;
4. maintenance heartbeat, Reclamation, and cleanup logs;
5. chat-api reconnect/history behavior and permanent Postgres Outcomes.

Recover by rolling forward. Do not introduce runtime reassignment or restore the
retired Fargate service.

## Controlled retirement release

The one-time procedure for removing the former service and its schema machinery
is [Fargate retirement handoff](agent-maintenance-handoff.md).

The later one-time procedure for removing the compatibility contract is
[Execution-runtime contract removal](execution-runtime-contract-removal.md).
