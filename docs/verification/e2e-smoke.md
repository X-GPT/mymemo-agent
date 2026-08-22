# Split-runtime end-to-end smoke verification

The Conversation smoke is one public-contract client with two targets. It uses
`AGENT_SMOKE_BASE_URL` to address either the local compose harness or the
deployed internal ALB; it does not read databases, logs, or runtime internals.
This guide records the verification strategy from
[#300](https://github.com/X-GPT/mymemo-agent/issues/300) and the core artifact
check from [#302](https://github.com/X-GPT/mymemo-agent/issues/302), plus the
local cancellation check from
[#303](https://github.com/X-GPT/mymemo-agent/issues/303).

## Check sets

`AGENT_SMOKE_SUITE` selects the check set and defaults to `core`. Any other
value fails before the first HTTP request.

- `core` performs three real Runs in one Conversation. Two Runs prove the SSE
  contract, exactly one committed Assistant message per Run, Agent-session
  resume, Workspace persistence, and gapless active-Run backlog rebuild. The
  third asks the agent to write unique exact content under
  `/home/user/artifacts/`; after `RUN_FINISHED`, the smoke requires exactly that
  conversation-relative artifact path, checks its listed size against the
  downloaded object, obtains `{ downloadUrl }`, and fetches the URL without
  identity headers. The response must be an attachment whose bytes match the
  request, with exactly one trailing newline tolerated.
- `full` is the local pre-merge superset. After the `core` checks it creates a
  second Conversation, asks its Run to start an immediate long-running Bash
  command, reads the live SSE incrementally, and calls the Run cancellation
  resource only after the first Tool invocation arrives. It requires the
  running-Run `cancel_requested` response, a `RUN_CANCELLED` live outcome with no surviving
  provisional Assistant text, and terminal recovery through Conversation
  history with the committed messages and Tool events ending `RUN_CANCELLED`. A third
  Conversation performs two searchable-document Runs against the local KB seed: the first
  reports the exact inventory count through `ListDocuments`; the second uses
  `SearchDocuments`, `LoadDocuments`, and `Read` to report the seeded title and
  first markdown heading. The smoke requires those Tool invocations in durable
  history and proves their exact projection. Because these assertions are coupled
  to the local fixture, `full` refuses to start unless
  `AGENT_SMOKE_MEMBER_CODE=demo-member`.

## Target strategy

| Target | Suite | Invocation | Credentials and network |
| --- | --- | --- | --- |
| Local compose | one Run | `bun run smoke:local` | Requires OpenRouter and E2B development credentials; uses Postgres, Redis, the development bridge, and the real local Runtime without AWS-managed Dispatch infrastructure. |
| Deployed internal ALB | `core` | `AGENT_SMOKE_SUITE=core scripts/deploy/prod_smoke.sh` | The wrapper expects `agentcore`. Run inside the VPC under the synthetic identity targeted in the Statsig exposure gate. The caller receives no provider, sandbox, AWS, or database secrets. |

There is no staging target. The credential-free integration suite and local
Compose smoke are the pre-merge bars; the deployed core suite is the post-deploy
bar. The smoke identity must be allowlisted in the
`mymemo_agent_split_runtime_enabled` Statsig gate before a gate-open deployed
run. Until the in-VPC release one-shot in
[#305](https://github.com/X-GPT/mymemo-agent/issues/305) lands, the deployed
command remains manual from a VPC-reachable environment.

## Local smoke

`bun run smoke:local` builds the local-only Chat API and Runtime targets, waits
for the durable bridge, and admits one public Run that must reach
`RUN_FINISHED`. The production images omit both local composition entrypoints
and the bridge application.

The deployed wrapper fixes the expected runtime to `agentcore`. After the
synthetic identity is targeted in the exposure gate, the public creation response
must report that runtime before the client admits its first Run. A deployed pass
is the gate for beginning the staged exposure rollout described in the
[AgentCore rollout runbook](../runbooks/agentcore-rollout.md#deploy-order); it is
not evidence for widening past the next observed stage.

## Deterministic verification of the verifier

The suite logic is tested through its CLI against loopback stub Conversation
servers. The tests cover the gate-closed path and a complete core Run flow
through strict admission, cursor-free standard AG-UI events, terminal history
recovery, and identity-free signed-object fetching:

```sh
bun test scripts/smoke/agent-conversation-smoke.test.ts
```

The broader client-contract decision and release contract are recorded in
[ADR-0012](../adr/0012-expose-a-full-ag-ui-agent-surface.md).
