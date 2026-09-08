# Agent Runtime

The #732 Runtime, separate from v1's `apps/agentcore-runtime`. The front owns
sandbox lifecycle and workspace persistence; this process invokes its supplied
session and copies the CLI transcript to S3 around each query. No DynamoDB
is wired here.

`POST /invocations` accepts the #732 payload (timestamps are Unix milliseconds;
`scope.kind` is `general`, `collection`, or `document`). `budgetUntil` includes
two minutes of grace after the ten-minute query budget. Every SDK message is
serialized unchanged as NDJSON, including thinking and Hand tool results.
A terminal SDK result ends the single-prompt query; Runtime failures emit one
`mymemo.error` line. Budget expiry interrupts the SDK so its result survives;
caller disconnect closes the query. Both cases close the HTTP server after
cleanup. `/ping` reports `Healthy` or `HealthyBusy`; concurrency is one.

The SDK and native CLI are pinned together at 0.3.251. The `claude-agent-sdk`
npm alias keeps v1's SDK at 0.3.233 when Bun hoists workspace dependencies. Query settings are
isolated in a per-Turn temporary `CLAUDE_CONFIG_DIR`, removed after CLI cleanup.
The image's fixed empty project directory is `/opt/mymemo/project`.

## Verify

From the repository root:

```sh
bun install --frozen-lockfile
bun test apps/agent-runtime --timeout=30000
bunx tsc -p apps/agent-runtime
bunx biome check apps/agent-runtime
docker build --platform linux/arm64 -f apps/agent-runtime/Dockerfile -t mymemo-agent-runtime .
```

Tests run the pinned CLI against the fake Anthropic Messages server adapted
from #730's `sdk-session-probe.ts`, without a model key. They compare every
forwarded message with the SDK iterator, exercise thinking and
ten aliased tools, budget interruption, disconnect, Runtime-side failure, and
fatal sandbox loss with no SDK result. Hand checks exercise real local shell
commands through a fake sandbox transport, path confinement, edits and caps.

Set `CODE_INTERPRETER_ID` to a custom SANDBOX-mode interpreter and provide
the Runtime execution role with InvokeCodeInterpreter authority. The front
starts and stops sessions; the Runtime never restarts a lost session. See
`apps/agent-front` for the two-Turn workspace demo.

The always-loaded `hand` MCP server exposes Bash, Read, Write, Edit, Glob and
Grep via SDK aliases. `tools: []` disables built-ins; `allowedTools` lists only
the six `mcp__hand__*`, three `mcp__docs__*`, and `mcp__ui__present` targets. Model paths live under `/ws`, mapped to `ws/`
in the sandbox. `/ws` is a file-tool alias; Bash starts in `~/ws` and uses
relative paths or `~/ws`. The model is instructed to execute `!command`
verbatim without the leading `!`. Bash has a 120-second default and 600-second maximum timeout,
without background mode. Hand output is capped at 64 KiB; writes at 1 MiB.
File operations reject traversal and escaping symlinks. Binary reads return
size and MIME type; PDF page extraction uses Bash. Edits require one match.
For a real-model memory smoke, provide AWS credentials with transcript Get/Put
access and export `OPENROUTER_API_KEY` securely, then:

```sh
docker run --rm --platform linux/arm64 -p 8080:8080 \
  -e OPENROUTER_API_KEY -e KB_DATABASE_URL -e WORKSPACE_BUCKET -e AWS_REGION -e CODE_INTERPRETER_ID \
  -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_SESSION_TOKEN \
  mymemo-agent-runtime
# In another terminal:
bun run apps/agent-runtime/smoke.ts
```

Optional image env: `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`),
`OPENROUTER_DEFAULT_MODEL` (default `anthropic/claude-sonnet-5`), `PORT` (8080),
`LOG_LEVEL` (info). The CLI receives `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, and an explicitly empty `ANTHROPIC_API_KEY`, as in v1.
On AWS, `OPENROUTER_API_KEY_SECRET_ARN` selects Secrets Manager `AWSCURRENT`
bootstrap instead of the local direct key. Deployment, IAM and invocation steps:
[Runtime runbook](../../docs/runbooks/agent-runtime.md).

## Transcript continuity

`WORKSPACE_BUCKET` is required. Each Turn downloads the one object
`_transcripts/<conversationId>.jsonl` before querying, to
`/tmp/claude/<turnId>/projects/-opt-mymemo-project/<conversationId>.jsonl`.
The fixed empty cwd is `/opt/mymemo/project`; the pinned CLI test verifies its
project-key convention. An existing file selects `resume: conversationId`;
the first Turn selects `sessionId: conversationId` when the object is absent.

The role has only GetObject/PutObject on `_transcripts/*`. Without ListBucket,
S3 reports a missing key as AccessDenied; only `seq: 1` accepts that response
(or NoSuchKey). Later download failures stop the Turn rather than discard memory.
An initial permission misconfiguration is indistinguishable from absence;
the failed upload is counted, and the next Turn fails closed.

After any SDK `result`, including an error result, the Runtime waits for CLI
exit and uploads the whole file before ending the HTTP stream. Upload/read
failures log the Conversation/Turn ids and an embedded CloudWatch
`MyMemo/AgentRuntime` / `TranscriptUploadFailures` Count, without changing the
Turn result. Every exit removes the per-Turn config directory. A crash before
a result does not replace the prior transcript. Cleanup (#743) deletes exactly
`_transcripts/<conversationId>.jsonl`; there are no part objects or alternate prefixes.

The fake-model test runs three fresh servers/config directories, verifies
model message counts **2 → 5 → 8**, and asserts the one object's size grows.
The smoke script sends a random fact, then asks for it in a second Turn. Against
AWS, it uses two different Runtime session ids and the local `mymemo` profile:

```sh
AGENT_RUNTIME_ARN='<simplified Runtime ARN>' bun run apps/agent-runtime/smoke.ts
```

The smoke prints its Conversation id; remove its transcript object after
recording S3 size/continuity evidence using an operator role, not the Runtime role.

## Knowledge-base documents

The always-loaded `docs` MCP server exposes `ListDocuments`, `SearchDocuments`
and `LoadDocuments`. Its client takes the user and frozen Scope from the validated
invoke payload; tool arguments cannot widen either. The KB connection is read-only,
with `sslmode=verify-full`, supplied by `KB_DATABASE_URL_SECRET_ARN` (AWSCURRENT)
or `KB_DATABASE_URL` for local runs. No document-access audit is written.

`LoadDocuments` writes `/ws/.mymemo/docs/<id>.md` through the same Hand session
and returns only metadata. The existing workspace tarball carries the Docs cache
between Turns. Use `Read` or `Grep` on the returned path; the front streams all
three public document-tool names with its existing 8 KiB output preview.

Run the deterministic real-KB smoke with a read-only credential and a disposable
session on an existing SANDBOX-mode interpreter (no model call):

```sh
AWS_PROFILE=mymemo AWS_REGION=us-west-2 \
  KB_DATABASE_URL_SECRET_ARN='<KB secret ARN>' \
  CODE_INTERPRETER_ID='<interpreter id>' bun run apps/agent-runtime/docs-smoke.ts
```

It checks the role has no table-write grants, then validates scoped list/search,
metadata-only load, Grep in the sandbox and outside-Scope rejection. It stops the
session in `finally` and prints no document content or credentials.
