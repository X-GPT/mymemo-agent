# Recover production releases by containing and rolling forward

Status: accepted (2026-08-20). Amends ADR-0025 and ADR-0027 by superseding
their production binary-rollback consequences.

Production recovery for the AgentCore release train is roll-forward only. An
incident is contained before another binary is deployed: disable the SSM
Dispatch control, turn the Execution runtime gate OFF, and turn the exposure
gate OFF only when all new agent work must stop. Keep the runtime-aware
agent-worker running because it remains the global queued-Run expiration and
Reclamation runner for both execution runtimes.

After containment, prepare a reviewed corrected release on `main`, deploy it
through **Release deploy**, verify the complete coordinated system while the
controls remain safe, and restore Dispatch and gate cohorts deliberately. Do
not select an older Runtime version, container digest, or ECS task definition
as a production recovery target. The release workflow records current facts —
including the deployed commit and immutable Runtime image digest — rather than
maintaining previous-binary targets that no supported procedure consumes.

ADR-0027's dedicated publisher process and authority boundary remains. The
publisher can still be paused, restored, and mechanically deployed without
sharing an agent-worker lifecycle, but it has no independently versioned
rollback lane; executable corrections remain on the coordinated compatibility
cycle defined by ADR-0028. ADR-0025's deployment-readiness fence also remains
as defense in depth: it rejects an accidentally selected runtime-unaware
agent-worker while `agentcore` Conversations exist, but it does not make that
binary a supported rollback target or license deleting or reassigning those
Conversations during release recovery.

## Considered options

- **Capture the live Runtime digest before every release.** Rejected because a
  recorded target without a tested operator procedure creates a false recovery
  promise and requires control-plane permissions used by no other release
  operation.
- **Retain independent publisher binary rollback.** Rejected because the
  publisher shares a schema and dispatch envelope with chat-api, the consumer,
  and the Runtime. Selecting an older publisher recreates the compatibility
  matrix that ADR-0027 and ADR-0028 deliberately avoided.
- **Delete or reassign AgentCore Conversations before restoring an older
  runtime-unaware worker.** Rejected as destructive incident handling when
  containment followed by a corrected release preserves durable user state.

## Consequences

- The incident runbook has one recovery sequence: contain, correct, deploy,
  verify, and deliberately restore controls.
- The release workflow does not discover, validate, retain, or report a
  previous Runtime image digest, and its role needs no Runtime-list permission
  for that purpose.
- Existing AgentCore Conversations can remain temporarily unavailable while
  Dispatch is disabled. Their immutable execution runtime and durable state are
  preserved while the corrected release is prepared.
- Recovery time depends on producing and reviewing a forward fix. The SSM
  control, runtime gate, optional exposure gate, queue backstop, and staged
  restoration bound the incident while that work completes.
