# Split-runtime end-to-end smoke verification

The Conversation smoke is one public-contract client with two targets. It uses
`AGENT_SMOKE_BASE_URL` to address either the local compose harness or the
deployed internal ALB; it does not read databases, logs, or runtime internals.
This guide records the verification strategy from
[#300](https://github.com/X-GPT/mymemo-agent/issues/300) and the core artifact
check from [#302](https://github.com/X-GPT/mymemo-agent/issues/302).

## Check sets

`AGENT_SMOKE_SUITE` selects the check set and defaults to `core`. Any other
value fails before the first HTTP request.

- `core` performs three real Runs in one Conversation. Two Runs prove the SSE
  contract, exactly one committed Assistant message per Run, Agent-session
  resume, Workspace persistence, and byte-exact durable reconnect replay. The
  third asks the agent to write unique exact content under
  `/home/user/artifacts/`; after `done`, the smoke requires exactly that
  conversation-relative artifact path, checks its listed size against the
  downloaded object, obtains `{ downloadUrl }`, and fetches the URL without
  identity headers. The response must be an attachment whose bytes match the
  request, with exactly one trailing newline tolerated.
- `full` is the local pre-merge superset. It currently includes all `core`
  checks; [#303](https://github.com/X-GPT/mymemo-agent/issues/303) and
  [#304](https://github.com/X-GPT/mymemo-agent/issues/304) extend it with the
  local-only interrupt and seeded-document checks. Use `full` now so those
  checks join the pre-merge command without changing operator habits.

`AGENT_SMOKE_PREVIEW_MODE` is independent of the suite. Use `required` to prove
the Redis Live-preview lane, `forbidden` to prove Postgres-only delivery, or the
default `optional` when preview transport is not the subject of the run.

## Target strategy

| Target | Suite | Invocation | Credentials and network |
| --- | --- | --- | --- |
| Local compose | `full` | `bun run smoke:local` | The running trusted services hold the developer's OpenRouter, E2B, and AWS credentials. The smoke process needs only localhost access. |
| Deployed internal ALB | `core` | `AGENT_SMOKE_SUITE=core scripts/deploy/prod_smoke.sh` | Run inside the VPC under the allowlisted smoke identity. The caller receives no provider, sandbox, AWS, or database secrets. |

There is no staging target. Local-real is the pre-merge bar; the deployed core
suite is the post-deploy bar. The smoke identity must be allowlisted in the
`mymemo_agent_split_runtime_enabled` Statsig gate before a gate-open deployed
run. Until the in-VPC release one-shot in
[#305](https://github.com/X-GPT/mymemo-agent/issues/305) lands, the deployed
command remains manual from a VPC-reachable environment.

## One-command pre-merge run

First satisfy the compose prerequisites and start the stack as described in the
[local harness guide](../../README.md#local-end-to-end-harness). With the stack
healthy, run:

```sh
bun run smoke:local
```

The command fixes the local base URL, gate-open expectation, seeded fixture
member, and `full` suite. A pass prints the Conversation id and all Run ids so
the evidence can be correlated with service logs. A failure exits non-zero with
the assertion that failed.

## Deterministic verification of the verifier

The suite logic is tested through its CLI against loopback stub Conversation
servers. The tests cover both required-preview and forbidden-preview artifact
happy paths, the allowed single trailing newline, identity-free signed-object
fetching, tampered object bytes, and environment validation:

```sh
bun test scripts/smoke/agent-conversation-smoke.test.ts
```

The broader client-contract evidence and release record remain in
[ADR-0008 hard-cutover verification](./adr-0008-hard-cutover.md).
