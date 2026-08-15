# Orchestrate canary control without retrying Runs

Status: accepted

A temporary, manually dispatched GitHub workflow whose AWS OIDC authority is
restricted to this repository's exact `main`-branch subject starts or reattaches
to a Postgres Campaign record and an AWS Step Functions Standard execution, then
may disconnect without affecting the campaign. The workflow is deleted after
the AgentCore verification campaign, so normal production retains no
campaign-launch trigger. Postgres owns the monotonic campaign lifecycle and
final verdict; Step Functions durably coordinates provisioning, five sequential
scenarios, fault injection, validation, reporting, and cleanup. A scheduled
watchdog invokes the same idempotent cleanup when campaign heartbeats or
deadlines lapse.

Each Canary scenario has deterministic Run and message identities. Control
operations, exact admission, outbox publication, observation, validation, and
cleanup may retry with those identities, but orchestration never substitutes a
new Run after an Outcome. A fresh model execution requires a new Campaign
idempotency key and a fresh synthetic Conversation.

## Considered options

- **Run the campaign inside GitHub Actions.** Rejected because runner
  cancellation would become an implicit production abort and long waits would
  have no durable AWS control state.
- **Use one long-running Lambda.** Rejected because its execution limit and
  restart behavior do not fit the campaign and cleanup windows.
- **Retry a failed scenario with a new Run.** Rejected because it would hide a
  production failure and violate the Run-at-most-once vocabulary.

## Consequences

- The Campaign record separates lifecycle from verdict and permits only one
  non-terminal campaign at a time.
- Step Functions observes durable Postgres state, not the temporary Live Stream,
  before interruption, Runtime death, or scenario validation.
- Operator abort is an explicit durable control action; killing the workflow
  process is not cancellation.
