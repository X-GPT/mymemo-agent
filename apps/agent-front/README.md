# Lambda front — Conversations, Turns and Workspaces

Implements #735, #737 and #738 / Spec #732 alongside v1. Identity parsing, Summary
and the fail-closed Statsig gate are copied without importing chat-api.
Creation and send consult the gate; existing history and management do not.

## Local development

From the repository root:

```sh
bun install
docker compose -f apps/agent-front/compose.yml up -d
bun run --cwd apps/agent-front db:init
# Start apps/agent-runtime's container on :8080 (see its README).
AWS_PROFILE=mymemo AWS_REGION=us-west-2 CODE_INTERPRETER_ID=<sandbox-interpreter-id> bun run --cwd apps/agent-front dev
```

DynamoDB Local (:8000) and MinIO (:9000) are disposable local stores.
`db:init` creates `mymemo-conversations` and `mymemo-history` once per container
lifetime. The local front listens on :3000 with an explicitly open development
gate. Supply `X-Member-Code` and `X-Partner-Code`, optionally `X-Team-Code`.

```sh
TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 TEST_S3_ENDPOINT=http://127.0.0.1:9000 bun run --cwd apps/agent-front test
bunx tsc --project apps/agent-front/tsconfig.json
bunx biome check apps/agent-front
```

The integration suite creates an isolated DynamoDB table. Without its endpoint
it skips. With `TEST_S3_ENDPOINT`, history uses a real isolated S3 bucket;
otherwise injected history storage supports the DynamoDB-only CI job.
See [DEMO.md](DEMO.md) for the prototype browser demonstration.

## Response contract

`POST /v1/conversations/:id/messages` accepts strict `{ text, requestId }`.
Text is nonblank and at most 32 KiB in UTF-8; the request id is nonempty and
at most 1020 UTF-8 bytes (DynamoDB's sort-key limit minus `REQ#`). Keep it
unchanged for an explicit retry. Never call `sendMessage` while `useChat.status`
is `submitted` or `streaming`: the server's 409 is the race backstop.

An owned, live Conversation admits one Turn via a transaction: `turnCount`
CAS, fresh `processing { turnId, seq, until }`, request-id item, title if unset,
and activity/index update. Rename wins over automatic title selection. Until
is start + ten-minute budget + two-minute grace. Rejections are 409:

- `{ error: "processing", turnId }` for an active Turn.
- `{ error: "archived" }` for an archived Conversation.
- `{ error: "duplicate_request", turnId, status }` for the same id/text.
- `{ error: "request_id_conflict" }` for the same id with different text.

Retries resolve the existing request before testing archive/processing.
Missing, foreign and tombstoned Conversations return 404 before validation.

A 200 response is AI SDK UIMessage SSE with
`x-vercel-ai-ui-message-stream: v1`. The front mints the assistant message id:
`start` (Turn metadata) → per-model `start-step`, `text-start`/`text-delta`/
`text-end`, `finish-step` → `message-metadata` → `finish` or
`error { errorText }`, then `[DONE]`. Reasoning and duplicate SDK assistant
snapshots are suppressed. Budget abort maps to `budget_exceeded`, provider
402/429 to `quota_exceeded`, a Runtime `mymemo.error` to its code, and other
failures or a missing result to `internal_error`.

Before invocation, `_history/<id>/turn-<six-digit-seq>.json` contains the user
message (`u_<turnId>`), `processing`, and `assistant: null`. At stream end one
replacement stores `{ turnId, seq, requestId, status, errorCode?, startedAt,
endedAt?, user, assistant }`. History timestamps are ISO UTC; invocation
payload timestamps are Unix milliseconds. Only after that write does the front
conditionally clear its own processing marker and emit the terminal chunks.
A failed persistence operation cannot report successful completion.

`GET …/messages?limit=&cursor=` returns `{ messages, nextCursor }`, newest
whole Turns first, user then assistant within each Turn. Limit counts Turns;
cursor is the exclusive Turn sequence. Reload mid-Turn returns only the user
message with processing metadata: render “working”. Replace client history
wholesale, since live user ids differ. No partial reply, resume or reconnect.
If a processing object no longer matches the Conversation's processing Turn,
its served metadata becomes `error` / `abandoned`. An expired marker alone
is not abandonment until a later send replaces it. A Lambda timeout leaves
processing history; a later send admits after expiry. A lost connection has
unknown outcome: reload history and never resend automatically.

## Lambda entry point and deployment handoff

`src/lambda.ts` exports `handler` for Hono `streamHandle` requests and a
scheduled invocation with `{"source":"mymemo.cleanup"}`. HTTP bodies cannot
select cleanup. Required env: `CONVERSATION_TABLE`, `STATSIG_SERVER_SECRET_ARN`,
`WORKSPACE_BUCKET`, `AGENT_RUNTIME_ARN`, `CODE_INTERPRETER_ID`, and AWS SDK region/role environment.
Production uses the Statsig gate, drains pending Turns before the handler
returns, and flushes exposures. No production local-endpoint or open-gate switch.

See [the deployment and signing-proxy runbook](../../docs/runbooks/agent-front.md).
Deployment (#742 / #750): Node.js 22 / arm64, `AWS_IAM` `RESPONSE_STREAM`
Function URL, fourteen-minute timeout, Statsig `linux-arm64-gnu` binary,
DynamoDB read/transaction/update permissions, S3 history Get/Put/List/Delete,
S3 Workspace Get/Put, and `bedrock-agentcore:InvokeAgentRuntime`,
`StartCodeInterpreterSession`, `InvokeCodeInterpreter`, `StopCodeInterpreterSession`
on the SANDBOX-mode interpreter. Only the trusted BFF may invoke:
identity headers are trusted assertions. Run the same browser demo on AWS when
both deploys land; #737 explicitly permits the local demonstration meanwhile.

Listing strongly re-reads GSI projections to hide tombstones; the index remains
eventually consistent. Archive may proceed during a Turn. Delete requires no
fresh processing marker. Scheduled cleanup removes workspace, artifacts (including
the manifest), history, and the exact transcript key before request items and
the tombstone, in that order. Partial S3 delete failures preserve the tombstone
for retry.

## Workspace and Hand tools

Each admitted Turn starts a 900-second Code Interpreter session, restores
`_workspace/<id>/workspace.tgz` into `~/ws`, and passes the session id to the
Runtime. After a terminal SDK result (including an error result), the front
exports the tree in 8 MiB parts, three per `readFiles` call, then replaces the
S3 object. Above 64 MiB compressed, the previous object stays and the Turn
ends `workspace_too_large`. A missing result or fatal Runtime error skips
export. Session stop runs in `finally`, before terminal history and chunks.

The six model-facing tools (`Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep`)
produce tool-input and tool-output chunks. History retains their inputs and
outputs with the reply; output previews are capped to 8 KiB of valid UTF-8
with `truncated` and `totalBytes`. Tool failures use `tool-output-error`.
See [SANDBOX-DEMO.md](SANDBOX-DEMO.md) for the two-session continuity demo.

## Downloads and display-only UI

After a Runtime result, the front exports the Workspace and mirrors regular
files under `ws/artifacts/` into `_artifacts/<conversationId>/`. Files over
100 MiB, symlinks and the reserved `.manifest.json` path are excluded; paths
must be normalized and relative. The manifest records nanosecond `mtime` as a
string, compares `(sizeBytes, mtime)`, and keeps the SHA-256 path-based ID and
creation timestamp stable across edits. Changed files use 8 MiB parts, at most
three per `readFiles` call. Missing files are removed from the mirror.

`GET /v1/conversations/:id/artifacts` lists the current manifest path-sorted;
`GET /v1/conversations/:id/artifacts/:artifactId/download-url` signs the copy
for 300 seconds as an attachment. Both require ownership, bypass the exposure
gate, and hide tombstoned Conversations. An unknown artifact returns 404.

A changed mirror emits one `data-artifacts` part before terminal metadata on
both successful and error results. A missing result or lost sandbox skips
copy-out. Workspace export failures still attempt artifact publication, so
an over-cap Workspace can retain downloadable output.

`PresentUI` runs inside the Runtime's SDK MCP server, using the shared
`@mymemo/ui-catalog` ADR-0017 validator (five components, 16 KiB envelope and
pinned Vega-Lite schema). Invalid calls return repair errors; successful calls
become `data-generative-ui` parts without tool activity. Both data part types
are saved with the complete reply and replayed by `GET messages` after reload.
See [DOWNLOADS-DEMO.md](DOWNLOADS-DEMO.md) for verified browser and sandbox results.
