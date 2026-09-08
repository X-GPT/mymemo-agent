# Pre-cutover gate (#745)

Do not cut over or declare #745 complete until every row below has live evidence
on the candidate deployment. Local tests alone do not pass this gate.

## Candidate verification

Run the BFF smoke with a real enabled business-session token (keep it out of
logs and shell history). `BFF_URL` is the deployed mymemo-service origin,
`BFF_TOKEN` the opaque bearer token, and `WORKSPACE_BUCKET` its workspace bucket.
The AWS storage inspection uses the local `mymemo` profile.

```sh
bun run apps/agent-front/scripts/pre-cutover.ts
```

This creates only its own Conversation and attempts DELETE in `finally`.
If interrupted or DELETE reports 409, retry that fixture's DELETE after its
processing deadline; do not remove someone else's Conversation. It checks
streamed text, Write/Bash, the chart and artifact parts, immediate download,
active-send 409, processing-only mid-Turn history, full reply after completion,
Turn-2 recall and tarball update. It is deliberately not a complete nine-check
certification: record the remaining probes separately below.

| # | Required live evidence | Status on 2026-09-08 |
| --- | --- | --- |
| 1 | Through deployed mymemo-service: streamed text, Write+Bash, data-artifacts, immediate download | Pending authenticated BFF run. Direct AWS two-Turn download demo ran; not equivalent. |
| 2 | Turn 2 Bash reads Turn 1 file; tarball changes each Turn | Pending BFF smoke and tarball ETags. Direct AWS artifact includes both Turns. |
| 3 | Bash: metadata has no IAM credentials, example.com fails, workspace bucket 403 | PASS on deployed interpreter via executeCommand; full model/BFF path still pending. |
| 4 | Concurrent send 409; send after until makes prior history abandoned | Local transaction tests pass; fresh live stale-admission probe pending. |
| 5 | Mid-Turn user+processing only; complete reply including chart after reload | Local tests pass; BFF smoke pending. |
| 6 | Fresh Runtime session recalls earlier Turn; transcript upload failures zero | Local real-SDK transcript tests pass; live recall and metric window pending. |
| 7 | Immediate 404; automatic deletion of all four S3 namespaces and DynamoDB items within ten minutes | PASS on deployed stack: automatic sweep removed all objects and items in 88.891 seconds; details below. |
| 8 | Real ten-minute budget with copy-out; >64 MiB rejection preserving tarball; killed Runtime's Sandbox expires by TTL | Live cap passed; ten-minute budget exposed wrong error mapping (fixed locally); candidate retest and killed-session TTL pending. |
| 9 | Ungated member 403; Statsig unreachable fails closed | Live new test identity returned 403; isolated Statsig-outage probe pending. |
| Alarms | New metrics observed, alarms enabled and SNS wired | Definitions validated; candidate not deployed. |

For #4, use only an owned disposable Conversation: stop its Runtime, wait for
its recorded `processing.until`, send again and read the prior Turn's history.
Never shorten a real user's processing deadline. For #8, use another disposable
Conversation and a Bash command that writes a sentinel then sleeps past ten
minutes; require `budget_exceeded` and the copied sentinel. In a separate Turn,
write 65 MiB of random data outside artifacts (zeros compress and cannot test
the cap); require `workspace_too_large` and unchanged previous tarball ETag.
Record the killed Turn's Sandbox session ID, configured timeout, and terminal
status after that TTL. Do not infer expiration solely from the timeout setting.
For #9, inject the Statsig network failure only into an isolated candidate front;
never block production's shared egress or change its exposure gate to run a test.

## Alarm contract

`infra/terraform/front-alarms.tf` adds fixed-size metric series via JSON log
filters in `${common_name}/Front`. Conversation and Turn IDs stay in logs,
never dimensions. `TurnOutcomes` includes finished and healed abandoned Turns;
per-code rates divide errors by outcomes observed in the same five-minute
window, so this is an operational rate, not a cohort completion statistic.
Persistence failures have a separate alarm because no durable outcome exists.

- Each error code alarms above 5% in five minutes. Budget exhaustion, workspace
  overflow, sandbox start and persistence failures also alarm on any occurrence.
- `SandboxStartSeconds` measures successful session starts. Admission logs map
  requestId to turnId; session-start logs include the returned session ID.
- `TarballBytes` includes rejected export sizes; `CopyInSeconds` and
  `CopyOutSeconds` measure successful archive transfers, excluding artifact sync.
- Native Lambda `Url5xxCount` covers HTTP failures; `Errors` covers unhandled
  errors, scheduled sweep failures, and hard timeouts. Native Runtime
  `SystemErrors` is scoped to this Runtime's DEFAULT endpoint. Idle absence is
  non-breaching for demand-driven services.
- Existing cleanup-age alarm remains: oldest Tombstone >3,600 seconds.
- `MyMemo/AgentRuntime/TranscriptUploadFailures` is the existing EMF metric.
  Spec #732's amendment and ADR-0035 retired `mirror_error`; do not resurrect it.
- Actions and recovery notifications use `alarm_action_arns`, the existing SNS
  destination. Application logs carry IDs when available; pre-admission,
  invalid invocation and aggregate cleanup events use null for absent IDs.
  AWS platform and third-party startup logs cannot carry a Turn before one exists.

AWS references: [Function URL metrics](https://docs.aws.amazon.com/lambda/latest/dg/urls-monitoring.html)
and [Runtime metrics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-runtime-metrics.html).
Runtime `SystemErrors` dimensions were also verified with live `list-metrics`:
Resource = runtime ARN, Operation = InvokeAgentRuntime, Name = agent name::DEFAULT.

After candidate deployment, record its Front CodeSha256, Runtime image digest,
head SHA, the acceptance window, Conversation/Turn/session IDs, metric data and
alarm actions. Check CloudWatch after metric delivery; no datapoints is not proof
of zero errors. Publish the per-row results on Spec #732. Keep failed/pending
rows explicit until retested; neither this runbook nor a green unit suite opens
the cutover gate.

## Live deletion evidence — 2026-09-08

Existing `apps/agent-front/scripts/deletion-demo.ts` passed against the deployed
AWS Front/Runtime using the `mymemo` profile and `codex-smoke` / `mymemo` identity.
This direct Function URL run does **not** claim BFF coverage or candidate deployment.
Front CodeSha256: `CpSrYOeQP5FQtVY5C9ieVhPf3m9h5pFy/Q/YajNP3cw=`.
Conversation `c08819a9-ffb0-429d-ae3c-1ed8ada0ecc9`, started 17:08:58.258 UTC;
DELETE at 17:09:28.932 UTC. Two real Turns completed, the downloaded artifact
contained both Turns, all six Conversation routes immediately returned 404,
and the automatic sweep emptied workspace (1 object), artifacts (2), history
(2), transcript (1), and DynamoDB (3 items) within **88.891 seconds**. The old
artifact URL returned 404 at age 88.902 seconds. No manual sweep was invoked.

## Live sandbox isolation evidence — 2026-09-08

Interpreter `mymemo_hand_prod-8hwya8imUU`, disposable session
`01M2104V8GN7VTY1PJVTP758TQ`: after obtaining an IMDSv2 token, the metadata IAM
security-credentials path returned 404; `curl https://example.com` exited 6
(HTTP 000); anonymous workspace-bucket access returned 403. No AWS credential
environment variables or `~/.aws` directory existed. Probe exit code 0, session
stopped in `finally`. The first probe returned IMDS 401 without a token and was
correctly rejected; the successful retry used IMDSv2. This directly exercises
the deployed SANDBOX's shell, not a model-generated Bash call through the BFF.

## Local verification

54 Front tests passed with real DynamoDB Local and MinIO, including failure
correlation, rejected tarball size, artifact/history ordering and cleanup retry.
The Runtime tests passed in the combined run; its only failure was the old
cleanup-log assertion, subsequently updated and passed in the Front rerun.
Both scoped TypeScript checks, Biome, Front package build and Terraform validate
passed (existing provider deprecation warnings only). AWS `test-metric-filter`
accepted the per-code and sandbox-start filters and excluded negative fixtures.

## Additional live checks — 2026-09-08

Direct AWS fixture `b14bd81a-f461-4945-9bcd-168b2edff00d`: baseline Turn
`a3286b4d-ecb9-4224-8c0c-ed3576608f93` produced a 416-byte tarball with ETag
`8aa8b31e24556e25a0034de6508cf2b1`. Turn
`0e841c7b-53a2-4bf5-ab2c-6bf21781dc1d` wrote 65 MiB of random data, ended
`workspace_too_large` at 17:16:41.065 UTC, and left that exact ETag unchanged.
The real ten-minute Turn `319af235-67b4-4f61-9bba-afca2b845cbc`
ended at 17:26:42.555 UTC (started 17:16:41.297) with `internal_error`, so the
budget acceptance **failed**. Copy-out did run: `budget.txt` downloaded with
HTTP 200 and exact content `BUDGET-COPY-745`. The fixture was deleted (204).

The Runtime's SDK returned `terminal_reason: aborted_tools`; the shared Front
converter only recognized `aborted_streaming`. This PR adds the missing mapping
and a regression fixture from the real result (red before the fix, green after).
A fresh deployed Runtime/Sandbox with a 30-second diagnostic budget reproduced
`internal_error` before the fix, then passed through the corrected local Front
converter as `budget_exceeded` in 30.121 seconds: Conversation
`a722dbaf-fe17-4786-bae1-387150562e2e`, Turn
`d50e7027-177a-468e-86e8-2a19946d136e`. Both diagnostic sessions were stopped and
Conversations deleted (204). This verifies the root cause but does not replace
the full ten-minute test through the candidate deployed Front.

The new test identity `codex-745-denied-8c3fe5b1` received 403 from the deployed
Front's actual Statsig gate. No gate setting was changed.

The candidate Runtime image built locally. Its SDK tests under local ARM64
emulation terminated the CLI with SIGSEGV; the native ARM64 CI image tests on
PR head `255354e` passed. Treat the native check as the deployment-platform
verification and retain the local emulation limitation in the record.
