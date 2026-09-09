# Pre-cutover gate (#745)

The candidate passed the live gate below on 2026-09-08. This is acceptance
of the parallel deployment, not authorization to cut over or merge.

## Candidate and evidence

Application source: `d1f5ee2663eee1280fd2f9471266987a5560d24a`.
Later evidence-only commits do not change the deployed application or Terraform.

- Front `mymemo-agent-prod-front`, updated 18:04:06 UTC, CodeSha256
  `OMmbK6mMoZC9tcSC8b4bjMMIGghUZbIvqnR0fKPpKaU=`.
- Runtime `mymemo_agent_prod-dTdWcn3FDq`, version 8, READY, image digest
  `sha256:068197fe1247a46dc97cdc4d7cf9ffc1f57862ef3235bd68581ace9a2ee97684`.
- Terraform applied 25 creates and two updates (Front/Runtime), with no deletions. Alarm actions use the existing SNS
  `arn:aws:sns:us-west-2:637423444544:mymemo-staging-alarms`.
- BFF exercised in the logged-in production UI at `https://app.mymemo.ai/agent`.
  Conversation `df6521b4-36ae-4007-b2d5-0ebcf8a5d030`; Turn IDs below.
- [Spec evidence](https://github.com/X-GPT/mymemo-agent/issues/732#issuecomment-5589249470).

| # | Candidate live result |
| --- | --- |
| 1 | PASS: BFF Turn 1 used Write and Bash, streamed tool progress and READY, rendered a bar chart, and published `data-artifacts`. The UI download action succeeded; the issued artifact URL separately returned HTTP 200 with the expected file marker. |
| 2 | PASS: Turn 2 Bash read the persisted marker and appended `Turn 2`. Tarball ETag changed from `c354e46440b793029f18f785a18bf3d0` (441 bytes) to `c558335e4b9b5088205e20bf622cd313` (455 bytes). |
| 3 | PASS: BFF Turn 3 Bash obtained an IMDSv2 token without disclosing it; IAM security-credentials path returned 404, example.com failed DNS (curl exit 6), bucket returned 403. AWS credential environment variables and `~/.aws` were absent. |
| 4 | PASS: a signed Front send overlapping BFF Turn 2 returned HTTP 409 with its active Turn ID. An owned stale-admission fixture returned 409 before expiry, then a new deployed Turn completed and prior history became `abandoned`. |
| 5 | PASS: during Turn 1, a second browser tab loaded only the user message and Working/processing, while the original displayed live Write/Bash progress. After completion, reload restored the complete reply and chart. During Turn 2, durable history had only its processing user message plus the completed first pair. |
| 6 | PASS: fresh Turn 2 Runtime session recalled `ORCHID-745-SEP8` before its first tool; the marker was not written into a file. Transcript grew from 22,222 bytes after Turn 2 to 37,399 after Turn 3. No transcript-upload error logs occurred in the acceptance window; the error-only metric had no datapoints, not a measured zero. |
| 7 | PASS: candidate BFF fixture DELETE returned 204, all six Conversation routes immediately returned 404, and automatic Scheduler cleanup emptied all four S3 namespaces and DynamoDB within 105,906 ms. The old artifact URL also became invalid. |
| 8 | PASS: a real ten-minute Turn returned `budget_exceeded` in 601,394 ms and its sentinel artifact downloaded successfully. A 65 MiB random workspace returned `workspace_too_large` and preserved its previous tarball. The killed Runtime's Sandbox was TERMINATED, including the check after its 900-second TTL. |
| 9 | PASS: actual ungated identity returned 403. The exact Front ZIP in a network-disabled ARM64 Lambda Node 22 container returned 403 after the real Statsig SDK reported `NetworkError`; only a non-sensitive dummy key and local secret-delivery stub were used. Production gate/network settings were unchanged. |
| Alarms | PASS: candidate metrics observed; 13 new alarms plus existing cleanup-age alarm have actions enabled and the expected SNS destination. Fault-test alarm transitions successfully executed SNS actions. |

BFF Turn 1 `bef9dcd0-13b1-44a6-a6b9-625e2332f061` ran
18:04:50.109–18:05:41.167 UTC. Turn 2
`436b9fe0-dc63-409e-b492-ee8eefbdbbfc` started 18:06:46.859 UTC.
Turn 3 `be884518-4ebe-40e9-a27e-202b0053fdec` ran
18:10:30.719–18:10:57.765 UTC.
The BFF checks used browser interaction; the concurrent HTTP status, durable
objects, and artifact contents were independently checked through the signed
Front and AWS APIs, not presented as a token-based BFF script run.

Stale fixture `08583173-255a-4b18-8917-f794777798f5` first completed a real
baseline Turn. Only this owned fixture received an injected interrupted
admission and an expired `processing.until`; no running user's deadline was
changed. Prior Turn `9a7656ec-3a9e-444c-8aee-16580336d779` became abandoned;
next Turn `c4f26959-fafb-4c28-90f7-4acd4057364e` completed at 18:12:44.869 UTC.
An earlier injection before any transcript existed healed the history but the
next Runtime failed closed on missing prior memory; it is not the successful
recovery evidence above and does not change the existing memory-loss policy.

Budget/cap fixture `927709ae-0921-41fb-a424-cc4d984896c2`:
cap Turn `78d016b0-ccab-4d51-9bbb-785205292407` preserved baseline ETag
`4893d98a14536cf32ec285c496ef15c2` (415 bytes). Budget Turn
`62989536-8a2b-49ba-b2f4-512234a08a18` ran
18:05:06.846–18:15:08.130 UTC; `budget.txt` contained `BUDGET-COPY-745`.
The earlier deployment returned `internal_error` because SDK cancellation
reported `aborted_tools`. This PR recognizes it alongside `aborted_streaming`;
the captured result is a regression test and the candidate retest passed.

Killed fixture `107c46e8-7884-478e-8c0b-ea125f1bd25e`, Runtime session/Turn
`237c2c59-def2-4a90-8e25-69ebbbe7b876`: StopRuntimeSession at 18:07:32.392 UTC;
Front completed with `internal_error` at 18:09:37.646 UTC. Sandbox
`01M21386DZEDTN2AZDT7ZG7JCZ` was created 18:07:27.673 UTC with timeout 900;
GetCodeInterpreterSession confirmed TERMINATED before TTL and again at
2026-09-08T18:23:05.114385+00:00 (age 937.441 seconds).
This proves no orphan remained past TTL; it does not claim TTL caused the stop.
All disposable Conversations were deleted and their storage cleanup verified.

## Repeat the gate

Run the BFF smoke with a real enabled business-session token, keeping it out of
logs and shell history. `BFF_URL` is the deployed mymemo-service origin,
`BFF_TOKEN` the opaque bearer token, and `WORKSPACE_BUCKET` its workspace bucket.
AWS inspection uses the local `mymemo` profile.

```sh
bun run apps/agent-front/scripts/pre-cutover.ts
```

The script checks streaming, Write/Bash, chart/artifact parts, download,
active-send 409, processing-only history, recall and tarball update. It creates
only its own Conversation and attempts DELETE in `finally`; retry that fixture
if processing returns 409. Separately run the security, stale-admission,
ten-minute budget, compressed-cap, killed-session TTL and isolated Statsig
outage probes. Use random bytes for the cap; zeros compress. Never block
production egress, weaken the gate, or mutate another user's Conversation.
Observe terminal Sandbox status after TTL rather than inferring it from config.

## Alarm contract

`infra/terraform/front-alarms.tf` adds fixed-size metric series via JSON log
filters in `${common_name}/Front`. IDs stay in logs, never dimensions.
`TurnOutcomes` includes finished and healed abandoned Turns; per-code rates use
outcomes observed in the same five-minute window, not completion cohorts.

- Error-code rates alarm above 5% in five minutes. Sandbox-start and persistence
  failures also alarm on any occurrence. Budget/cap errors use only rate alarms
  to avoid duplicate notifications.
- `SandboxStartSeconds` measures successful starts. Admission logs map
  requestId to turnId; start logs include the session ID.
- `TarballBytes` includes rejected exports; `CopyInSeconds` and `CopyOutSeconds`
  measure successful archive transfers, excluding artifact sync.
- Lambda `Url5xxCount` covers HTTP failures and `Errors` covers unhandled errors,
  sweep failures and hard timeouts. Runtime `SystemErrors` uses the DEFAULT
  endpoint's observed Resource, Operation and Name dimensions.
- Existing cleanup-age alarm remains (>3,600 seconds). Existing
  `MyMemo/AgentRuntime/TranscriptUploadFailures` EMF covers upload failures;
  Spec #732/ADR-0035 retired `mirror_error`.
- Front, transcript-upload and runtime-health alarms notify `alarm_action_arns`
  only on ALARM; recovery emails are disabled. The separate cleanup-age alarm
  retains recovery notifications. Missing metrics are
  non-breaching for demand-driven services; absence alone does not prove success.
  Logs use null IDs before admission and for aggregate cleanup/platform events.

Observed candidate metrics included 13 outcomes in the initial window,
workspace-too-large=1, internal-error=2 (killed Runtime and missing-memory
fixture), abandoned=2; sandbox starts 0.733–1.312 seconds, copy-in
0.175–0.282 seconds, copy-out 0.234–0.398 seconds, and rejected tarball
68,169,206 bytes. The final budget metric sum was 1, with 14 total outcomes; the cleanup audit found
zero remaining objects/items (observed cleanup-age maximum 283.186 seconds). The budget alarm transitioned OK → ALARM
and successfully executed its SNS action.
SNS action history records successful deliveries for workspace-overflow,
internal-error and abandoned alarm transitions. Runtime health and transcript
alarms were OK with enabled actions.

AWS references: [Function URL metrics](https://docs.aws.amazon.com/lambda/latest/dg/urls-monitoring.html)
and [Runtime metrics](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/observability-runtime-metrics.html).

## Verification

54 Front tests passed with DynamoDB Local and MinIO. Scoped Front/Runtime
TypeScript, Biome, Front packaging, Terraform validate and all seven CI checks
passed at application commit `d1f5ee2`. Native ARM64 CI SDK/image checks passed;
local ARM64 emulation crashed the CLI with SIGSEGV, so it is not used as evidence
of native behavior. AWS filter tests included the real Lambda log prefix and
negative fixtures. Fresh Ponytail and two-axis reviews must cover the final PR
head, including this evidence; do not merge as part of this gate.
