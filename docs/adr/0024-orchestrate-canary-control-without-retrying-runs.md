# Orchestrate canary control without retrying Runs

Status: accepted

A checked-in operator command runs only from a clean, current `main` revision
with the mandatory `mymemo` profile. It verifies the AWS account and region,
accepts only a Campaign idempotency key and explicit deployed-version
confirmation, assumes a narrowly scoped campaign-launch role, and starts or
reattaches to a Postgres Campaign record and an AWS Step Functions Standard
execution. The command may exit without affecting the campaign. Postgres owns
the monotonic campaign lifecycle and final verdict; Step Functions durably
coordinates provisioning, five sequential scenarios, fault injection,
validation, reporting, and cleanup. A scheduled watchdog invokes the same
idempotent cleanup when campaign heartbeats or deadlines lapse. The launch role
is removed and the operator command retired after the final AgentCore
verification campaign, leaving normal production without a campaign trigger.

Each Canary scenario has deterministic Run and message identities. Control
operations, exact admission, outbox publication, observation, validation, and
cleanup may retry with those identities, but orchestration never substitutes a
new Run after an Outcome. A fresh model execution requires a new Campaign
idempotency key and a fresh synthetic Conversation.

## Considered options

- **Use GitHub Actions to launch or run the campaign.** Rejected because a
  disposable workflow and OIDC path add a second control plane for one operator.
  Runner cancellation must not become an implicit production abort, and long
  waits need durable AWS control state.
- **Use one long-running Lambda.** Rejected because its execution limit and
  restart behavior do not fit the campaign and cleanup windows.
- **Retry a failed scenario with a new Run.** Rejected because it would hide a
  production failure and violate the Run-at-most-once vocabulary.

## Consequences

- The Campaign record separates lifecycle from verdict and permits only one
  non-terminal campaign at a time.
- Step Functions observes durable Postgres state, not the temporary Live Stream,
  before interruption, Runtime death, or scenario validation.
- Operator abort is an explicit durable control action; terminating the launcher
  process is not cancellation.
