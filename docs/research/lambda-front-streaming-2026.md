# A Lambda front streaming UIMessages while invoking the AgentCore Runtime

**Research date: 2026-09-04.** Resolves
[#720](https://github.com/X-GPT/mymemo-agent/issues/720) for the
[v3 managed-agent map (#719)](https://github.com/X-GPT/mymemo-agent/issues/719).
Sources are primary AWS documentation and SDK typings read on the research date; versions read:
`@aws-sdk/*` v3 at the repo's `3.1124.0` pin (`apps/chat-api/package.json`),
`@statsig/statsig-node-core` **0.19.8**. Repo facts cited below were verified against `main`
at `161b06a`.

## Question

Can a Lambda be the front that mymemo-service calls, streaming a Turn's UIMessage SSE to the
client while it invokes the AgentCore Runtime — and under what limits?

**Short answer: yes, with a 15-minute ceiling per invocation.** Lambda response streaming works
on Function URLs, on the `InvokeWithResponseStream` API, and (since 2025-11-19) on API Gateway
REST APIs — not on HTTP APIs or ALB targets. The Runtime streams for up to 60 minutes per
invocation, the Lambda for at most 15, and when the Lambda dies mid-stream nothing it did
reaches the Runtime. The contract has to be written around that asymmetry (see
[Consequences](#consequences-for-the-contract)).

## Paths that stream

| Path | Streams? | Notes | Source |
| --- | --- | --- | --- |
| **Function URL** (`InvokeMode: RESPONSE_STREAM`) | Yes | 200 MB streamed response; public endpoint only (no PrivateLink, does not stream inside a VPC); auth `NONE` or `AWS_IAM`. | [config-rs-invoke-furls](https://docs.aws.amazon.com/lambda/latest/dg/config-rs-invoke-furls.html), [urls-configuration](https://docs.aws.amazon.com/lambda/latest/dg/urls-configuration.html) |
| **`InvokeWithResponseStream` API** (SDK call) | Yes | Event stream of `PayloadChunk` / `InvokeComplete`; works over the `com.amazonaws.<region>.lambda` interface endpoint from inside a VPC. | [API_InvokeWithResponseStream](https://docs.aws.amazon.com/lambda/latest/dg/API_InvokeWithResponseStream.html), [configuration-vpc-endpoints](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-endpoints.html) |
| **API Gateway REST API** (`responseTransferMode: STREAM`) | Yes, since 2025-11-19 | `AWS_PROXY` / `HTTP_PROXY` integrations only; stream up to 15 min; regional idle timeout 5 min; no caching, content encoding or VTL mapping; the function must emit the JSON metadata prelude + 8 NUL bytes within the first 16 KB (`awslambda.HttpResponseStream.from` does it). | [response-transfer-mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html), [response-transfer-mode-lambda](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode-lambda.html), [what's new 2025-11](https://aws.amazon.com/about-aws/whats-new/2025/11/api-gateway-response-streaming-rest-apis/) |
| **API Gateway HTTP API** | No | Not in the HTTP-API feature set. | [http-api-vs-rest](https://docs.aws.amazon.com/apigateway/latest/developerguide/http-api-vs-rest.html) |
| **ALB Lambda target** | No | Buffered; request + response capped at 1 MB. | [elasticloadbalancing lambda-functions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html) |

Writing a streaming function is Node.js-managed-runtime only: wrap the handler in
`awslambda.streamifyResponse`, write with `pipeline()`, and end the stream before the handler
returns (Node 24 no longer waits for unresolved promises)
([config-rs-write-functions](https://docs.aws.amazon.com/lambda/latest/dg/config-rs-write-functions.html)).

## Limits

| Limit | Value | Source |
| --- | --- | --- |
| Lambda function timeout | 900 s, hard | [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Lambda streamed response size | 200 MB | [configuration-response-streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html) |
| Lambda streaming bandwidth | uncapped for the first 6 MB, then 2 MB/s | same |
| Lambda request payload | 6 MB | [gettingstarted-limits](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html) |
| Lambda `ClientContext` (the only out-of-band caller field on `Invoke`) | 3,583 B | [API_InvokeWithResponseStream](https://docs.aws.amazon.com/lambda/latest/dg/API_InvokeWithResponseStream.html) |
| Lambda Init phase | 10 s | [lambda-runtime-environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html) |
| API Gateway REST stream | 15 min max; 5 min idle (regional) | [response-transfer-mode](https://docs.aws.amazon.com/apigateway/latest/developerguide/response-transfer-mode.html) |
| AgentCore Runtime sync request timeout | 15 min | [bedrock-agentcore-limits](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) |
| **AgentCore Runtime streaming maximum duration** | **60 min** | same |
| AgentCore Runtime async job | 8 h | same |
| AgentCore Runtime invoke payload / chunk | 100 MB / 10 MB | [API_InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html), limits page |
| AgentCore Runtime compute per session | 2 vCPU / 8 GB | limits page |
| AgentCore active sessions | 5,000 (us-east-1, us-west-2), else 2,500 | limits page |
| AgentCore data-plane / new-session TPS | 1,000 / 25 | limits page |
| AgentCore session idle timeout | default 900 s, range 60–28,800 s | [runtime-lifecycle-settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html) |
| AgentCore session max lifetime | default 28,800 s, range 60–28,800 s, never reset | same |

## Timeout behaviour

- **Lambda times out mid-stream.** The client sees a truncated body (curl exits 18);
  `InvokeWithResponseStream` callers receive a final `InvokeComplete` event carrying an
  `ErrorCode`; the execution environment is reset
  ([configuration-response-streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html),
  [API_InvokeWithResponseStream](https://docs.aws.amazon.com/lambda/latest/dg/API_InvokeWithResponseStream.html)).
  Nothing the Lambda had in flight (its open `InvokeAgentRuntime` response) survives.
- **Client disconnects from the Lambda.** AWS: "Streamed responses are not interrupted when the
  invoking client connection is broken; customers are billed for the full function duration"
  ([configuration-response-streaming](https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html)).
  The Lambda keeps running to completion or timeout; it is not told the reader left.
- **Lambda's caller disconnects from the Runtime.** Undocumented. The only documented lever is
  `StopRuntimeSession`, which terminates the whole session, not one invocation
  ([runtime-stop-session](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-stop-session.html)).
- **Runtime's own ceiling.** A streaming invocation may run 60 minutes; a non-streaming one
  15; anything longer is the 8-hour async-job mode
  ([runtime-long-run](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-long-run.html)).

## Invoking the Runtime from Lambda

**Call shape.** `POST /runtimes/{arn}/invocations` with header
`X-Amzn-Bedrock-AgentCore-Runtime-Session-Id`; the response body is whatever the container
returned from `POST :8080/invocations` — JSON or an SSE `text/event-stream`
([API_InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html),
[runtime-http-protocol-contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html)).
Today `apps/agentcore-runtime/src/server.ts` answers with `application/x-ndjson`; the service
relays bytes, so the front can consume that as-is or the Runtime can switch to SSE. The
container's `GET /ping` reports `Healthy` | `HealthyBusy`.

**JS SDK v3.** `InvokeAgentRuntimeCommand` returns `response: StreamingBlobPayloadOutputTypes`
— use `transformToWebStream()` and pipe it into the Lambda's response stream. The client sets
no request timeout, and smithy's `node-http-handler` clears its timers once response headers
arrive, so a long body is never cut by the SDK; the only ceilings are the Runtime's 60 minutes
and the Lambda's 15.

**Session semantics.** The session id is the Conversation id
(`packages/agent-db/src/agentcore-dispatch.ts` sets `runtimeSessionId: row.conversationId`;
`apps/agentcore-runtime/src/runtime.ts` asserts it). The request doc says 33–256 characters;
the response pattern is `[a-zA-Z0-9][a-zA-Z0-9-_]*` — a 33–100 character id matching that
pattern is the safe intersection, which a UUID (36) satisfies. Each session is a dedicated
microVM with context preserved between invocations; states are Active → Idle → Stopped; idle
timeout defaults to 15 minutes and max lifetime to 8 hours; after Stop the next invoke provisions
fresh compute under the same id, and inconsistent ids force cold starts
([runtime-sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html),
[runtime-lifecycle-settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)).
AWS publishes no cold-start numbers ("start instantly"). The user-facing result: the Runtime's
per-Conversation microVM persists across Turns until 15 minutes idle, so a second Turn inside
that window skips the cold start.

**Errors.** 400 / 403 / 404; **409 `RetryableConflict`** during the session provisioning or
teardown window (the SDK auto-retries); **424 `RuntimeClientError`** when the container answers
4xx/5xx; 402 `ServiceQuotaExceeded`; 429; 500
([API_InvokeAgentRuntime](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeAgentRuntime.html)).

**IAM.** `bedrock-agentcore:InvokeAgentRuntime` on both `runtime/<id>` and
`runtime/<id>/runtime-endpoint/*`, plus `InvokeAgentRuntimeForUser` when the user-id header is
sent ([runtime-invoke-agent](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-invoke-agent.html)).

**The 15-minute Lambda vs 60-minute Runtime ceiling.** The Lambda is the shorter pipe. A Turn
the Runtime is happy to stream for 40 minutes is cut at 15 by the front, and — because a broken
downstream reader is not surfaced to the Runtime — the Runtime keeps working and writing with
nobody listening.

**Undocumented: per-session concurrency and disconnect.** Whether one session accepts a second
concurrent `InvokeAgentRuntime` or serialises it is not documented; only *commands*
(`runtime-execute-command`) are documented as running concurrently with an invocation
([runtime-execute-command](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-execute-command.html)).
What the Runtime does when the invoker's connection drops is equally undocumented. AWS documents
no Lambda-relays-AgentCore-stream pattern anywhere; the design below is ours.

## Auth options (mymemo-service → Lambda)

mymemo-service (Python, Fargate, same account) today calls chat-api through an internal HTTP
ALB (`infra/terraform/alb.tf`, `internal = true`) and passes identity in trusted `X-*` headers
(`docs/agents/security.md`).

| Option | Streams | Auth mechanism | Caller identity delivered | Network | Source |
| --- | --- | --- | --- | --- | --- |
| **SDK `invoke_with_response_stream`** over the Lambda VPC interface endpoint | Yes | Task-role SigV4 done by boto3; needs only `lambda:InvokeFunction` | None — only what the caller puts in `Payload` or `ClientContext` (≤ 3,583 B) | Private (`com.amazonaws.<region>.lambda` endpoint) | [boto3 invoke_with_response_stream](https://docs.aws.amazon.com/boto3/latest/reference/services/lambda/client/invoke_with_response_stream.html), [configuration-vpc-endpoints](https://docs.aws.amazon.com/lambda/latest/dg/configuration-vpc-endpoints.html) |
| Function URL, `AWS_IAM` | Yes | Manual SigV4 (`botocore.auth.SigV4Auth(creds, "lambda", region).add_auth(AWSRequest)`); since Oct 2025 needs `lambda:InvokeFunctionUrl` **and** `lambda:InvokeFunction` | `requestContext.authorizer.iam` (account, arn, userId) | Public only | [urls-auth](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html), [urls-invocation](https://docs.aws.amazon.com/lambda/latest/dg/urls-invocation.html) |
| Function URL, `NONE` + shared secret | Yes | Application-level | None | Public only | [urls-auth](https://docs.aws.amazon.com/lambda/latest/dg/urls-auth.html) |
| API Gateway REST, `AWS_IAM` | Yes | SigV4 for `execute-api:Invoke` | Authorizer context | Regional or private endpoint | [api-gateway-control-access-using-iam-policies-to-invoke-api](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-control-access-using-iam-policies-to-invoke-api.html); streaming + authorizers undocumented either way |
| Keep the ALB | **No** | Security groups / headers | Headers | Private | [lambda-functions](https://docs.aws.amazon.com/elasticloadbalancing/latest/application/lambda-functions.html) |

API keys are not authentication per AWS's own guidance.

**Recommendation: `invoke_with_response_stream` over the VPC interface endpoint.** No public
surface, no resource policy, no hand-rolled SigV4, and the caller streams the `EventStream`
(`PayloadChunk` / `InvokeComplete`, content type from `ResponseStreamContentType`) straight
through to the browser. The Invoke event carries no caller principal, so the identity headers
that chat-api reads today move into the JSON `Payload` (a `{ identity, conversationId, message }`
envelope) — the same trust model as now (only a trusted internal caller can invoke), just on a
different field. The Function URL is the fallback if a public HTTPS URL is ever required;
API Gateway REST only if an HTTP surface *and* a private endpoint are both required.

## Statsig in Lambda

`@statsig/statsig-node-core` 0.19.8 has no Lambda-specific documentation; the serverless guide
covers the general pattern
([guides/serverless](https://docs.statsig.com/guides/serverless),
[server-core/node-core](https://docs.statsig.com/server-core/node-core)).

- **Init at module scope**, once per execution environment: `new Statsig(key, options)`, then
  `await statsig.initialize()` — a network fetch of the spec set, "typically under a second".
  After that `checkGate` is synchronous and local. Lambda's Init phase is capped at 10 s
  ([lambda-runtime-environment](https://docs.aws.amazon.com/lambda/latest/dg/lambda-runtime-environment.html)),
  so start the promise at module load and await it in the handler, as
  `apps/chat-api/src/features/exposure-gate/exposure-gate.ts` already does (fail closed when it
  rejects).
- `initTimeoutMs` exists in the shipped typings
  ([statsig-generated.d.ts](https://cdn.jsdelivr.net/npm/@statsig/statsig-node-core@0.19.8/statsig-generated.d.ts))
  but not in the options table: on timeout init continues with defaults, which for our gate means
  a denial — the fail-closed behaviour we want. There is no `waitForInitialization`.
- **`await statsig.flushEvents()` before the handler returns** — Lambda freezes background work
  between invocations, so exposure logs otherwise stall until the next invoke (or are lost at
  reap).
- **Packaging.** The SDK is a napi native binary shipped as optional dependencies
  (`@statsig/statsig-node-core-linux-x64-gnu` / `-linux-arm64-gnu`); the one matching the
  Lambda architecture (AL2023, glibc) must be in the bundle, and a lockfile generated on macOS
  may omit it. Build the deployment package on Linux or pin the platform package explicitly.
- `dataStore` / `specAdaptersConfig` allow bootstrapping from a bundled spec (removing the
  cold-start fetch) but no node-core example is published
  ([guides/cdn-edge-testing](https://docs.statsig.com/guides/cdn-edge-testing)); not worth it
  until cold-start latency is measured.

## Consequences for the contract

1. **A Turn must complete within Lambda's 15-minute cap**, or the contract needs a
   resume-from-history story. v1 Runs have run for many minutes; the Runtime allows 60 in a
   single stream, the Lambda 15. Either the client contract bounds a Turn at ~14 minutes (the
   Runtime enforcing it so history ends cleanly), or the client must be able to reconnect and
   replay from persisted history after the front drops. The map has cut mid-Turn resume, so the
   first form — a Runtime-enforced Turn budget below the Lambda timeout — is the one that fits.
2. **The Lambda cannot cancel the Runtime on client disconnect** except with
   `StopRuntimeSession`, which kills the whole Conversation session. The map has already cut
   interrupt, so the design should embrace the AWS behaviour: the Runtime keeps executing and
   keeps writing history after the reader is gone, and the client sees the completed Turn on its
   next load. Do not wire disconnect to `StopRuntimeSession`.
3. **`processing` must be flipped off by the Runtime** (or by a DynamoDB Streams / finish write
   it triggers), never by the Lambda. The Lambda may time out or be reaped before the Runtime
   finishes, and a Lambda-owned "done" write would either fire early (truncated stream) or never
   fire. The Runtime is the only party that knows the Turn ended.
4. **Which path:** API Gateway REST streaming is the only option if an HTTP surface is
   required; a Function URL if a public URL is acceptable; otherwise the direct SDK
   `invoke_with_response_stream` over the VPC endpoint, which is the recommendation. HTTP APIs
   and the ALB are out — they do not stream. Only Node.js managed runtimes can write a streamed
   response.
5. **Unconfirmed: per-session concurrent invocations.** AWS does not document whether a second
   `InvokeAgentRuntime` on an active session runs concurrently or is serialised. The map's
   409-on-busy premise sidesteps it as long as the Lambda enforces single-flight per
   Conversation in DynamoDB (conditional write on `processing`) *before* it calls the Runtime —
   then the Runtime never sees a second invocation on a session, whatever its behaviour would be.
   Also unconfirmed: what the Runtime does when its invoker's connection drops (item 2 assumes
   it keeps running, matching the container-level contract; verify on the first live pass).
