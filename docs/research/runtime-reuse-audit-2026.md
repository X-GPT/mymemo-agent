# Reuse audit: `apps/agentcore-runtime` and the packages against the target shape

**Research date: 2026-09-04.** Resolves
[#722](https://github.com/X-GPT/mymemo-agent/issues/722) for the
[simplified-chat map (#719)](https://github.com/X-GPT/mymemo-agent/issues/719).
Audited tree: `main` at
[`161b06a`](https://github.com/X-GPT/mymemo-agent/commit/161b06a). Every verdict below comes
from reading the source (imports, seams, what each function actually touches), not the docs.
Line counts are `wc -l` of non-test `.ts` files; tests follow their module's fate and are
reported separately.

**Target shape (from #719, fixed 2026-09-04):** Lambda front (identity, Scope, exposure gate,
DynamoDB, 409 on a second message) → invokes the **AgentCore Runtime** with streaming →
Runtime hosts the Claude Agent SDK loop, **every file tool and Bash on the AgentCore Code
Interpreter** over an S3-backed workspace, transcript in the SDK's **S3 SessionStore**, wire is
the **AI SDK UIMessage stream**. No agent Postgres, no E2B, no Redis/Valkey, no AG-UI, no
dispatch/outbox/SQS, no Ownership fencing, no maintenance reclaimer, no interrupt, no
document-access audit ledger. Kept: generative UI catalog (ADR-0017), Downloadable artifacts
(ADR-0011), workspace persistence, document tools over the KB Postgres.

Verdict vocabulary:

- **reuse as-is** — no coupling to a deleted component; at most an import path or a renamed
  identifier (`runId` → `turnId`).
- **reuse after cutting `<coupling>`** — the logic survives, but the named seam must be
  replaced or removed first; the *notes* column says what stays.
- **delete** — exists only to serve a component the target removes, or the target replaces
  it with a platform feature.

This is an input to the Turn-execution and spec tickets, not a decision.

## Headline numbers

Non-test TypeScript audited: **20,106 lines** (`apps/agentcore-runtime` 9,092 — the issue's
"22.7k" counts its 13,675 test lines too — plus 11,014 across the eight packages and apps).
Tests alongside: 24,798 lines, which follow their module.

| | non-test lines | of which survives | of which goes |
|---|---:|---:|---:|
| `apps/agentcore-runtime` | 9,092 | ~3,700 (831 as-is + ~2,900 inside the 4,126 "reuse after" lines) | ~5,400 |
| `packages/agent-db` | 5,090 | ~1,450 (pure event / projection / quota / status vocabulary) | ~3,640 |
| `packages/document-tools` | 864 | ~800 | ~60 (the audit writer) |
| `apps/agentcore-dispatch-consumer` | 739 | ~140 (env + Secrets Manager helpers, invoke adapter, NDJSON prelude reader) | ~600 |
| `packages/live-text` | 2,612 | 0 | 2,612 |
| `packages/agentcore-dispatch` | 208 | 0 | 208 |
| `packages/agent-worker` | 705 | 0 | 705 |
| `apps/agentcore-dispatch-publisher` | 533 | 0 | 533 |
| `apps/agent-maintenance` | 115 | 0 | 115 |
| `apps/agentcore-local-dispatch-bridge` | 148 | 0 | 148 |
| **Total** | **20,106** | **~6,100 (≈30%)** | **~14,000 (≈70%)** |

The survivors cluster in four places: the SDK query wiring and stream consumption
(`sdk/start-run-query.ts`, `sdk/agent-stream.ts`, `sdk/assistant-message-assembler.ts`), the
generative-UI catalog (`ui-payload-validator.ts` + `agent-db/run-events.ts` +
`agent-db/tool-event-projection.ts`), the artifact publication seam + S3 store, and
`packages/document-tools`. Everything that touches a Run row, an Ownership epoch, a dispatch
envelope, a Redis relay, an AG-UI event or an E2B sandbox goes.

## `apps/agentcore-runtime` (9,092 non-test lines, 13,675 test lines)

Structure as read: `server.ts` is AgentCore's `/ping` + `/invocations` HTTP contract;
`runtime.ts` is the exact-acquisition state machine over dispatch envelopes;
`execution-services.ts` binds it to Postgres lease renewal; `run-serving.ts` owns the Run's
fenced writes, terminal transitions, interruption and the Redis Live Stream;
`sdk/start-run-query.ts` provisions E2B and builds the SDK `query()` options;
`sdk/agent-stream.ts` consumes the SDK stream into Postgres `run_events` plus AG-UI events;
`artifacts/` diffs a manifest of `/home/user/artifacts` and uploads changed files to S3;
`documents/` is an older in-tree copy of `packages/document-tools`.

### Entrypoint, acquisition, serving

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/index.ts` | 35 | reuse as-is | Boot + SIGINT/SIGTERM drain (`shutdown()` then `server.stop`). |
| `src/server.ts` | 139 | reuse after cutting `agentcore-dispatch-consumer/contract` | The AgentCore request contract is exactly right: `/ping` → `Healthy`/`HealthyBusy`, `POST /invocations` with `x-amzn-bedrock-agentcore-runtime-session-id`, 64 KiB bounded body, `idleTimeout: 0`. Cut the `InvalidAgentCoreDispatchEnvelopeError` import and change the response from an ndjson *receipt* to the UIMessage SSE body (`text/event-stream`). |
| `src/runtime.ts` | 246 | delete | Single-flight state machine keyed on dispatch identity: pending acquisition, duplicate-receipt, heartbeat timer, ownership-lost, drain-on-shutdown. The target has no acquisition (the Lambda's conditional write is the only admission); what remains is "one Turn at a time + `HealthyBusy`", ~30 lines, cheaper to rewrite than to carve out. |
| `src/execution-services.ts` | 90 | delete | Binds acquisition to `loadExecutingRunTx` / `renewConversationLeaseTx` / `releaseConversationTx`. All Postgres fencing. |
| `src/production.ts` | 101 | delete | Composition root: Secrets Manager + SSM enablement control + `createDatabaseAgentCoreAcquisitionBoundary` + `createRunServing`. Rewritten for the target's wiring (S3 SessionStore, Code Interpreter, DynamoDB). |
| `src/production-run-resources.ts` | 114 | delete | Composition root for the Run path: `createDatabase`, `createRedisLiveStreamRelay`, `createE2bSandboxProvisioner`, `Sandbox.kill` janitor. Rewritten; the constants (`DOCUMENT_*` caps, `SANDBOX_IDLE_MS`) carry over as values. |
| `src/run-serving.ts` | 737 | delete | Everything here is the Postgres Run lifecycle: fenced `appendRunEventsTx` model-content appends, `transitionRunTerminalTx` / `publishArtifactsAndTransitionRunDoneTx`, interruption observation via heartbeat, `markLiveStreamFailedTx`, Ownership-loss classification, "leave to Reclamation" reconciliation. The target's equivalent is one DynamoDB Turn-status write at stream end. The only reusable idea is the `TurnDisposition` (`completed` / `stopped`) → status mapping. |
| `src/run-live-stream.ts` | 177 | delete | Redis AG-UI producer (`RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR`, failure marker). No relay in the target — the Runtime's HTTP response *is* the stream. |
| `src/run-write-rejection.ts` | 30 | delete | Classifies `RunWriteRejected` (fence vs status). |
| `src/ownership-lease.ts` | 34 | delete | `renewConversationLeaseTx` wrapper. |
| `src/constants.ts` | 1 | reuse as-is | `RUNTIME_SHUTDOWN_TIMEOUT_MS`. |
| `src/logger.ts` | 15 | reuse as-is | pino + `toMessage`. |
| `src/utf8.ts` | 21 | reuse as-is | `takeUtf8Bytes`. |
| `src/config.ts` | 137 | reuse after cutting Postgres / E2B / Redis / dispatch config | Keep: the ambient-secret guard (`*_API_KEY must be read from Secrets Manager, not env`), `requireEnv`, the Secrets Manager `readCurrentSecret` resolution, `PORT` / `LOG_LEVEL`. Cut: `DB_PASSWORD_SECRET_ARN`, `E2B_API_KEY_SECRET_ARN`, `REDIS_URL_SECRET_ARN`, `AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME`, `RDS_CA_BUNDLE_PATH` / `NODE_EXTRA_CA_CERTS` (the KB URL still needs TLS — keep the CA path if the KB connection uses `verify-full`), `WORKER_HEARTBEAT_INTERVAL_MS`. |
| `src/runtime-config.ts` | 111 | reuse after cutting `@mymemo/agent-db/database-url` and `@mymemo/live-text` | Keep `openrouter` (`baseUrl` trailing-slash strip, `defaultModel`), `artifact.{bucket,region}`, `kbDatabaseUrl`, `logLevel`, `port`. Cut `agentDatabaseUrl`, `e2b*`, `redisUrl` (`resolveLiveStreamRedisUrl`), heartbeat. |
| `src/model-client.ts` | 30 | reuse as-is | `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` + pinned-empty `ANTHROPIC_API_KEY` env for the SDK subprocess. Provider-neutral. |
| `src/image-cli-contract.ts` | 68 | reuse after cutting the RDS CA-bundle check | Image-build smoke test: resolves + exec-verifies the CLI binary, with the x64-emulation ELF fallback. Drop the `RDS_CA_BUNDLE_PATH` / size assertion unless the KB TLS bundle stays in the image. |
| `src/sandbox-env.ts` | 10 | reuse as-is | `RunBinding` `{userId, conversationId, runId, sandboxId}` — rename `runId` → `turnId`, `sandboxId` → the Code Interpreter session id. |

### `sdk/` — query wiring, stream consumption, tools, transcript

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/sdk/claude-code-executable.ts` | 84 | reuse as-is | Resolves the platform CLI binary from the SDK package (glibc, not musl) and exec-verifies `--version` at boot. |
| `src/sdk/start-run-query.ts` | 497 | reuse after cutting Postgres (`loadRunStartedTx`, `runtime-store` sandbox pointer / orphan ledger / taint), the E2B provisioner and `sandbox-renewal`, and the Postgres session-store config | ~160 lines survive: `MYMEMO_SYSTEM_PROMPT` (paths change from `/home/user` to the Code Interpreter workspace), `RunQueryFn` seam, the throwaway `CLAUDE_CONFIG_DIR` per query, `buildQueryOptions` (`includePartialMessages: true`, `tools: []`, `settingSources: []`, `permissionMode: "dontAsk"`, `allowedTools` allowlist, `env` = process env + model-client env + config dir, `pathToClaudeCodeExecutable`, in-process `mcpServers`, stable `cwd`, `resume`), and `superviseTurn`'s settle-on-close. The prompt comes from the invocation payload, not `run_started`; `sessionStore` becomes the SDK's S3 store (#703); `provisionWorkspace` / `killOrRecordOrphan` / `recordReplacedSandbox` (~150 lines) go. Per #702 the file tools ride `toolAliases`, so the allowlist form changes too. |
| `src/sdk/run-processor.ts` | 101 | reuse after cutting `RunProcessor` / `RunProcessorFailure` from `run-serving` and `sessionEvidence` | The seam "start the query, consume the stream under a Run-scoped abort, return disposition + artifact publication" stays; drop `interruptionSignal`, `ownershipLostSignal`, the mirror evidence. ~60 lines. |
| `src/sdk/agent-stream.ts` | 683 | reuse after cutting `@ag-ui/core`, `AgUiTextStream`, `@mymemo/agent-db/run-events` + `tool-event-projection`, `appendModelContents`, and the interruption / ownership-lost / `mirror_error` branches | Keep (~250 lines): `SupervisedQuery`, `resultErrorText` (terminal `result` with `is_error`), the `assistant.error` rejection, `isReplayUserMessage`, `toolResultBlocks`, the provider-tool-use-id → public id map, PresentUI validation at envelope commit, the force-close deadline / `iterator.return()` handling. Replace the two sinks — durable `ModelContent` batches and AG-UI events — with one UIMessage-stream writer (`text-start/delta/end`, `tool-input-available`, `tool-output-available`, `data-*` parts for PresentUI and artifacts) and a history write at Turn end. `mirror_error` handling goes (#719: deliberately not handled). |
| `src/sdk/ag-ui-text-stream.ts` | 147 | delete | AG-UI `TEXT_MESSAGE_*` coalescer with a 50 ms window over the Redis producer. The AI SDK's `createUIMessageStream` / `text-delta` parts need no coalescing layer. |
| `src/sdk/assistant-message-assembler.ts` | 327 | reuse after cutting one type import (`AssistantMessageCompletedPayload` from `@mymemo/agent-db/run-events`) | Pure, well-tested SDK stream-event → envelope assembler (`message_start` … `message_stop`, contiguous block indices, completed `tool_use` capture, the pinned delta-subtype table). Keep it as the source of the durable assistant message and tool calls. |
| `src/sdk/run-tools.ts` | 180 | reuse after cutting `../documents/*` (use `packages/document-tools`) and the E2B `WorkspaceToolDeps` | Keep: `modelSchemaWithRawRuntime` (the Zod hook that exposes the catalog schema to the model while keeping raw input for the validator), the PresentUI `tool()` registration, `EXECUTOR_ALLOWED_TOOLS` derived from the built tool list, `createSdkMcpServer({ alwaysLoad: true })`. |
| `src/sdk/workspace-tools.ts` | 134 | reuse after cutting `SandboxFileClient` / `SandboxCommandClient` (E2B) and renaming parameters | The `tool()` wrappers are transport-neutral. Two changes: bind them to a Code Interpreter client, and rename inputs to mirror the built-ins (#708: `file_path`, `old_string`/`new_string`, `pattern`/`path`) so `toolAliases` can hand the SDK's Read/Write/Edit/Grep/Bash to them. |
| `src/sdk/session-store.ts` | 173 | delete | Postgres `SessionStore` adapter (`appendAgentSessionEntriesTx` under the Ownership fence, mirror evidence). Replaced by the SDK's S3 SessionStore (#703). Keep the 3-line `conversationWorkingDirectory()` — the cwd must stay conversation-stable so `projectKey` matches across invocations. |
| `src/sdk/sandbox-renewal.ts` | 63 | delete | E2B idle-window keep-alive timer. The Code Interpreter session lifetime is a platform setting and the workspace persists in S3. |
| `src/sdk/testing/sdk-message-fixtures.ts` | 173 | reuse as-is | SDK message fixtures for the assembler / stream tests. |
| `src/sdk/testing/session-mirror-fixtures.ts` | 36 | delete | Postgres mirror fixtures. |

### Generative UI (kept, ADR-0017)

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/present-ui-tool.ts` | 55 | reuse as-is | Pure handler: `validateUiPayload` → bounded ack or `invalid_ui_payload` repair error. |
| `src/ui-payload-validator.ts` (+ `schemas/vega-lite-v5.23.0.schema.json`, 1.87 MB) | 739 | reuse after cutting one type import (`UiNode` from `@mymemo/agent-db/run-events`) | Zod catalog schemas, ADR-0017 byte/row caps, Ajv over the vendored Vega-Lite schema. Move `UiNode` next to the validator; nothing else in `agent-db` is referenced. |

### Workspace tools and E2B

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/file-tools/file-tools.ts` | 438 | reuse after implementing a Code Interpreter `SandboxFileClient` and renaming inputs (#708) | `SandboxFileClient` is already an abstract `{readFile, writeFile, runCommand}`; the tool bodies (workspace-rooted path resolution, byte/line windows, Edit replace-all, Grep via `rg` with bounded output) are transport-neutral. Only the E2B implementation (`e2b/file-client.ts`) dies. Grep shells out to `rg` — the custom interpreter image must ship it. |
| `src/file-tools/testing.ts` | 48 | reuse as-is | In-memory `SandboxFileClient` contract tests. |
| `src/bash-tool/bash-tool.ts` | 332 | reuse after cutting `SandboxCommandSession.kill/reap`, `markSandboxTainted`, `recordCommandAudit` | Keep the timeout clamp, stdout/stderr byte caps, cwd resolution, outcome normalisation (~150 lines). The group-kill/reap protocol exists for interrupt-driven cancellation and E2B's raw-kill gap; with no interrupt, the Code Interpreter's own `executeCommand` timeout is the backstop. |
| `src/bash-tool/bash-wrapper.ts` | 158 | delete | `setsid` process-group wrapper + control files under `/tmp/mymemo-commands` + kill/reap shell programs, all tuned to E2B `commands.run`. Revisit only if a Code Interpreter session proves to leak background children. |
| `src/e2b/sandbox-provisioner.ts` | 201 | delete | Connect-or-create over `Sandbox.connect` / `Sandbox.create` with `lifecycle: { onTimeout: "pause" }`. |
| `src/e2b/command-client.ts` | 128 | delete | E2B `commands.run` behind the wrapper. |
| `src/e2b/file-client.ts` | 73 | delete | E2B `files.read/write` + `commands.run` for Grep. |
| `e2b-template/` (`template.ts`, `build.ts`, `verify.ts`, README) | 179 | delete | The pinned E2B template (base image digest + ripgrep .deb). Its *content* — python3 + `rg` — is the requirement list for the custom Code Interpreter image. |

### Artifacts (kept, ADR-0011)

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/artifacts/artifact-manifest.ts` | 80 | reuse as-is | Manifest entry shape + path validation (relative, normalised, no `..`, no control chars, ≤ 1 KiB). |
| `src/artifacts/artifact-publication.ts` | 240 | reuse after cutting `@mymemo/agent-db/artifact-store` (`recordArtifactObjectsTx` ledger, `ArtifactQuotaError`, `MAX_ARTIFACT_SIZE_BYTES`, `PublishedArtifact`) and the `RunRecord` type | Keep the baseline-vs-final manifest diff, `ArtifactWorkspace` / `ArtifactObjectStore` seams, per-entry size quota, and `withArtifactPublication` (publish only after the SDK stream ends cleanly). The object *ledger* existed so Reclamation could sweep non-current uploads; with no Reclamation, the target uploads then writes the artifact items to DynamoDB directly. Lift the quota constants out of `agent-db`. |
| `src/artifacts/artifact-workspace.ts` | 334 | delete | E2B-specific: a Python manifest walker and a descriptor-pinning program read through `/proc/<pid>/fd/3` via `commands.run({ background: true })`. On an S3-backed Code Interpreter workspace the manifest is `ListObjectsV2` under the artifact prefix and the bytes are `GetObject` (or a `CopyObject` into the artifact bucket, which makes `s3-artifact-object-store.ts` streaming redundant). Keep `ARTIFACT_ROOT` as a value and the `parseValidationCode` idea only if a command path is retained. |
| `src/artifacts/s3-artifact-object-store.ts` | 279 | reuse as-is | `PutObject` under 5 MiB, multipart above, abort on failure, size-mismatch guards. Possibly redundant if artifacts are copied S3→S3 (see above); the spec ticket decides. |

### Documents (in-tree copy)

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/documents/*.ts` (`audit`, `client`, `db`, `errors`, `kb-queries`, `list-`/`load-`/`search-documents-tool`, `scope`) | 1,236 | delete | Still what `sdk/run-tools.ts` wires today, but it is the *older* copy of the same tools that #665 extracted into `packages/document-tools` (which chat-api and in-vm-server already consume). Delete the copy; wire the Runtime to the package. The one seam worth noting survives in the package too: `LoadDocuments` writes through a `{ writeFile(path, content) }` cache-writer interface, which a Code Interpreter file client satisfies. |
| `db/init.sql` | 130 | reuse as-is | Local KB schema + fixture seed for the compose harness; it seeds the *KB* (kept), not the agent DB. Moves with the document tools' local harness. |

### Other

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/testing/agentcore-run-harness.ts` | 57 | delete | Drives `createRunServing` via `acquireQueuedRunForTest`. |
| `local/index.ts` | 68 | delete | Direct-env composition of the deleted acquisition + run-serving stack; rewritten with the new root. |
| `Dockerfile` | — | reuse after cutting the RDS bundle `ADD`, the `agentcore-dispatch-consumer` / `agent-db` / `agentcore-dispatch` / `live-text` `COPY` lines | The Bun manifests → `bun install --filter` → distroless release layering is right for the target image. |

## `packages/agent-db` (5,090 non-test, 6,693 test, 31 migrations)

One `schema.ts` (12 `pgTable`s), one Drizzle client seam, and per-table `*Tx` stores. The
package's value to the target is the **pure** logic that happens to live here.

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/run-events.ts` | 526 | reuse as-is | Zero imports. The durable event vocabulary and payload types, incl. `UiNode` / `UiComponent` / `UiPayloadEventPayload`, `PUBLIC_TOOL_NAMES`, `RunScope`, sequence validation. Drop the `interrupted` outcome arm. This is the generative-UI + tool-event *contract* the target keeps; it just lives in a Postgres package. |
| `src/tool-event-projection.ts` | 846 | reuse as-is | `zod` only. Per-tool defensive projection of SDK tool input / executor output into bounded (16 KiB) client payloads, PresentUI detection, `fitOrOmit`. Re-point the executor tool-name allowlist at the Code Interpreter tool names. |
| `src/database-url.ts` | 40 | reuse as-is | Pure URL assembly (password injection, `sslmode`). Still needed for the KB URL. |
| `src/artifact-store.ts` | 215 | reuse after cutting the fenced `publishArtifactsAndTransitionRunDoneTx` and the `artifact_objects` ledger | Keep the ~25 lines of quota rules (`MAX_CURRENT_ARTIFACT_PATHS`, `MAX_ARTIFACT_SIZE_BYTES`, `MAX_CONVERSATION_ARTIFACT_BYTES`, `ArtifactQuotaError`). The two-table swap becomes one DynamoDB manifest write. |
| `src/run-store.ts` | 1,228 | reuse after cutting Postgres, Ownership epochs, interrupt, reclamation (≈90% rewrite) | Keep only `RunStatus` / `TerminalRunStatus` / `isTerminalRunStatus`, `NormalizedRunInputV1`, `ActiveRunConflictError` (~60 lines) as the Turn-status vocabulary. `requestRunInterruptionTx`, `reclaimConversationTx`, `markLiveStreamFailedTx`, `expireUnownedQueuedRunsTx` are cut features. |
| `src/turn-store.ts` | 248 | reuse after cutting Postgres | v2's Turn queue over `conversation_messages`; every guarantee is a SQL from-status guard, which DynamoDB conditional writes replace one-for-one. Keep `TurnStatus` / `TurnOutcome`; port the six operations. |
| `src/schema.ts` | 704 | delete | Lift the status tuples (`ALL_RUN_STATUSES`, `TERMINAL_*`, `ALL_TURN_STATUSES`) into a ~20-line vocabulary file. |
| `src/client.ts`, `src/migrations.ts`, `drizzle.config.ts` | 50 | delete | The Drizzle seam every store couples to. |
| `src/session-store.ts` | 282 | delete | Postgres SDK `SessionStore` backing; the S3 SessionStore replaces it (#703). `isMainAgentSessionRef` (~35 lines) is worth keeping only if the S3 adapter keys by `(sessionId, subpath)` the same way. |
| `src/conversation-ownership.ts` | 139 | delete | Lease / epoch / `FOR UPDATE`. |
| `src/runtime-store.ts` | 219 | delete | E2B sandbox pointer, taint, orphan ledger, session-pointer publication. |
| `src/agentcore-dispatch.ts` | 373 | delete | Outbox table. |
| `src/testing.ts` | 220 | delete | PGlite harness replaying all 31 migrations. |

## `packages/document-tools` (864 non-test, 738 test) — kept minus the audit writer

| path | lines | verdict | notes |
|---|---:|---|---|
| `src/tools.ts` | 276 | reuse as-is | The three handlers (`listDocuments` ≤20 + zod-validated base64url cursor, `searchDocuments` ≤8, `loadDocuments` ≤10 ids / 256 KiB per doc / 1 MiB per call) return plain JSON or `{isError, text}`; no DB, no FS. **The Code Interpreter seam is already here**: `loadDocuments` writes through `DocsCacheWriter { writeTextFile({ path, content, abortSignal }) }` (`tools.ts:155-162`) under `path.join(workDir, ".mymemo/docs", "<id>.md")`. One implementation over the Code Interpreter file-write call, with the interpreter workspace as `workDir`, is the whole integration. |
| `src/client.ts` | 555 | reuse after cutting `deps.audit` | Scope model (`FrozenScope` general / collection / document, fail-closed `parseFrozenScope`), all KB SQL (`CURRENT_DOCUMENTS` CTE, keyset list, `search_tsv` FTS, `left(canonical_markdown, 50000)` fetch), and the scoped client. The audit is one injected `DocumentAccessLog.record` behind a private `audit()` helper with five call sites; remove the field, the helper, the five `await`s, and `DocumentToolBinding.turnId`. The DB seam is structural (`KbDb { query(text, params) }`); `createKbDb` is a 15-line `pg.Pool`. |
| `src/access-log.ts` | 33 | delete | *Is* the document-access audit ledger (Drizzle insert into `document_access_events`) and the package's only `@mymemo/agent-db` import. |

The MCP wiring is not in the package: `apps/in-vm-server/src/doc-tools.ts` (244 lines,
`createSdkMcpServer({ name: "mymemo-docs", alwaysLoad: true })`, `DOC_TOOLS_ALLOWED_TOOLS`) is
the closest existing template for the Runtime's wiring — but in-vm-server is *deleted now*
(#719), so copy the ~60 relevant lines into the Runtime before that lands. Two tests worth
porting before the runtime's `documents/` copy dies: `kb-queries.integration.test.ts` (190) and
`list-documents-tool.integration.test.ts` (152) are the only tests that run the KB SQL against
a real engine (PGlite); the package's `client.test.ts` fakes `KbDb`.

## `packages/live-text` (2,612 non-test, 182 test)

Delete the whole package. It is a Redis (`node-redis`, not ioredis) relay with two lanes —
v1 `live-stream-relay.ts` (703, AG-UI events, producer buffer + backlog re-attach) and v2
`turn-live-stream-relay.ts` (273, `UIMessageChunk` pub/sub) — over `redis-live-stream-relay.ts`
(243). The pure files (`live-stream-events.ts` 175 AG-UI encode/decode, `live-stream-telemetry.ts`
97, `live-stream-validation.ts` 63, `in-memory-live-stream-relay.ts` 62) are all relay-shaped or
AG-UI-shaped; 955 of the non-test lines are `*.contract.ts` test-support. In the target the
Runtime's invocation response *is* the stream and there is no second process to relay to.
Consumers to unwire: `agentcore-runtime` (4 files), `chat-api` (5), `in-vm-server` (3).

## `packages/agentcore-dispatch` (208), `packages/agent-worker` (705), the dispatch apps, `agent-maintenance`, the local bridge

| path | lines | verdict | notes |
|---|---:|---|---|
| `packages/agentcore-dispatch/src/{publisher,database-store,envelope,sqs-queue,ssm-control}.ts` | 208 | delete | Outbox claim→`SendMessage`→confirm, the SQS adapter, the SSM `"enabled"` kill switch (`ssm-control.ts` is 32 lines; copy the pattern if the Lambda front wants a kill switch). |
| `packages/agent-worker/src/maintenance-runner.ts`, `cleanup/{cleanup,advisory-lock,e2b-janitor}.ts` | 654 | delete | Reclamation runner + three sweeps (orphan E2B kill, deleted-conversation runtime rows, unreachable S3 objects) under `pg_try_advisory_lock`. |
| `packages/agent-worker/src/cleanup/s3-artifact-janitor.ts` | 36 | delete | `DeleteObject` adapter; an S3 lifecycle rule on non-current objects covers it. |
| `packages/agent-worker/src/logger.ts` | 15 | delete | Verbatim duplicate of the runtime's. |
| `apps/agentcore-dispatch-publisher/src/*` | 533 | delete | Publisher process, its own second advisory-lock, EMF metrics via structured logs (the ~25-line EMF pattern in `publisher-metrics.ts` is worth copying if the target wants metrics without a metrics SDK). |
| `apps/agentcore-dispatch-consumer/src/config-utils.ts` | 23 | reuse as-is | Zero imports: `requireEnv` (trim-empty check) + `createRetryableAsyncSingleton` (un-memoises on rejection). The Runtime imports it today; move it out of a dying app. |
| `apps/agentcore-dispatch-consumer/src/secret-config.ts` | 94 | reuse after cutting `resolveVerifiedAgentDatabaseUrl` | Keep `createCurrentSecretReader` (`GetSecretValue` @ `AWSCURRENT`, ~25 lines) and `verifiedDatabaseUrl` (enforces `sslmode=verify-full`; the Runtime applies it to `KB_DATABASE_URL`). |
| `apps/agentcore-dispatch-consumer/src/aws-adapters.ts` | 59 | reuse after cutting `./consumer` and `./contract` | `InvokeAgentRuntimeCommand` → async byte iterable — exactly what the Lambda front does. |
| `apps/agentcore-dispatch-consumer/src/receipt-stream.ts` | 25 | reuse after cutting the receipt type | Bounded (8 KiB) first-NDJSON-frame reader that does not wait for EOF; generic once the parse callback is swapped. |
| `apps/agentcore-dispatch-consumer/src/{contract,acquisition-boundary,consumer,handlers,invariants,production}.ts` | 538 | delete | Envelope/receipt schemas with `ownershipEpoch` / `workerId`, the in-Runtime acquisition commit boundary (the deepest coupling into `runtime.ts` / `execution-services.ts`), the SQS consumer, the queue invariants. `production.ts` (121) is the closest template for the Lambda front's bootstrap (lazy singleton config + secret resolution + clients) — rewrite against DynamoDB, don't port. |
| `apps/agent-maintenance/src/{config,main}.ts` | 115 | delete | The reclaimer process (E2B key + agent DB + S3 janitors + health port). |
| `apps/agentcore-local-dispatch-bridge/src/{bridge,index}.ts` | 148 | delete | Local SQS stand-in. The one detail to carry into local dev: `POST /invocations` with `x-amzn-bedrock-agentcore-runtime-session-id` against a local Runtime. |

## `apps/chat-api` (5,076 non-test; inventory only)

Not in scope for a per-file verdict, but the Terraform table needs its fate. Route mounting in
`src/app.ts` is ground truth. v2 to delete now (#719): `conversation-messages` 581,
`conversation-vm` 529, `checkpoint` 173, `gateway` 318 (≈1,600). v1 Run path, dies at cutover:
`conversations` 1,047 (`conversations.route.ts` is the AG-UI Run POST + SSE re-attach),
`run-store` 177, `conversation-history` 516, `artifacts` 275 (S3 presign + Postgres metadata —
the presign logic moves to the Lambda front). `features/ai-chat` (356) is already
production-dead: `ai-chat.route.ts` is mounted only from `local/index.ts`. Shared:
`conversation-store` 341 (`PostgresConversationStore` → DynamoDB), `exposure-gate` 113 (Statsig,
kept), `config` 224.

## Terraform (`infra/terraform`, provider `hashicorp/aws` locked at 6.61.0)

Verdicts: **dies at cutover** (only serves deleted components), **survives** (needed by the
target, possibly with edits), **mixed** (named resources on each side), **dying now** (MicroVM,
decided at charting).

| file | lines | verdict | notes |
|---|---:|---|---|
| `versions.tf` | 31 | survives | Backend `mymemo-agent/prod.tfstate`, `aws >= 6.50, < 7.0`. `random` becomes unused once `redis.tf` + `microvm.tf` go. |
| `shared_state.tf` | 37 | mixed | Survive: `terraform_remote_state.mymemo_service`, `aws_subnet.shared_egress`, `aws_subnet.shared_ecs_first` (VPC id). Die: `aws_ecs_cluster.shared`, `aws_vpc.shared`. `aws_caller_identity.current` and `aws_partition.current` are already unreferenced. |
| `secrets.tf` | 15 | mixed | Survive: `kb_database_url`, `openrouter_api_key` (the SDK loop stays on OpenRouter per `model-client.ts`). Die: `statsig_server` (moves to the Lambda front's own config), `e2b_api_key`. |
| `agentcore-runtime.tf` | 44 | survives | `aws_bedrockagentcore_agent_runtime.runtime` is reusable as-is: `network_mode = "VPC"` over `aws_subnet.private`, `server_protocol = "HTTP"`, digest-pinned image, `idle_runtime_session_timeout = 900` / `max_lifetime = 3600`. Only `environment_variables` and `security_groups` change. The `removed {}` block for the ECR repo can go once applied. |
| `agentcore-network.tf` | 149 | survives | Private subnets, fck-nat egress + alarm, `aws_security_group.runtime`. This is the Runtime's path to the KB and to the model API. |
| `agentcore-iam.tf` | 259 | mixed | Survive: `lambda_trust` (reuse for the front), `runtime_trust`, `aws_iam_role.runtime` + policy — with surgery: keep ECR/logs/xray/`WriteProductionArtifacts`; drop `ReadFailClosedDispatchControl`, `BoundedDispatchMetrics`, the e2b/redis/agent-db secret ARNs; **add** DynamoDB, SessionStore/workspace S3 (Get/Put/Delete/List — today the artifact grant is write-only), and `bedrock-agentcore:*CodeInterpreterSession*`. Die: `aws_iam_role.consumer` + its two policies (~110 lines); the `bedrock-agentcore:InvokeAgentRuntime` statement in `data.consumer` is the one to copy into the front's policy. |
| `agentcore-locals.tf` | 61 | mixed | Survive: `agentcore_name_prefix`, `vpc_id`, `private_subnets`, `shared_public_subnet_ids_by_az`, `runtime_environment` (rewritten). Die: `lambda_common_environment`, `lambda_security_group_ids`. `runtime_security_group_ids` currently includes `services` and `live_redis_clients` — see `rds.tf`. |
| `agentcore-outputs.tf` | 114 | mixed | Survive the Runtime outputs (`agent_runtime_id/arn`, `runtime_image_digest`, `private_subnet_ids`, `runtime_security_group_id`, …). Die: `dispatch_queue_*`, `dead_letter_queue_url`, `consumer_*`, `dispatch_enabled_parameter_name`, `alarm_*`. |
| `agentcore-moved.tf` | 26 | mixed | Applied no-ops; the three targeting dispatch addresses go with them, the other two can be dropped. |
| `agentcore-queue.tf` | 54 | dies at cutover | KMS key + alias, SQS queue + DLQ, SSM `dispatch_enabled`. **All four carry `prevent_destroy = true`** → a lifecycle-strip apply before the destroy apply. |
| `agentcore-lambdas.tf` | 35 | dies at cutover | Consumer Lambda + SQS event-source mapping. The *shape* (zip via `var.consumer_lambda_package`, `filebase64sha256`, arm64 / nodejs22, VPC-attached) is the template for the front. |
| `agentcore-alarms.tf` | 95 | dies at cutover | The four dispatch alarms (PR #474's v1 set). |
| `alb.tf` | 36 | dies at cutover | chat-api ALB, target group, listener. |
| `ecs.tf` | 209 | dies at cutover | Task definitions + services for chat-api, agent-maintenance, dispatch-publisher, agent-migration. |
| `iam.tf` | 191 | dies at cutover | ECS execution/task roles. Only `chat_api_artifact_read` (`s3:GetObject` on `artifacts/objects/*`) has a successor — the Lambda front. |
| `network.tf` | 107 | dies at cutover | SGs `alb`, `services`, `agentcore_dispatch_publisher`, `agent_maintenance`. **`services` is load-bearing twice** — it is the source of the KB ingress rule and a member of `runtime_security_group_ids` — fold both onto `aws_security_group.runtime` first. |
| `rds.tf` | 88 | mixed | Everything dies (`aws_db_instance.agent` has `deletion_protection = true` + `skip_final_snapshot = false` → two-phase, and a final snapshot) **except `aws_security_group_rule.agent_services_to_kb_db`**, which must survive rewritten: its `source_security_group_id` is `aws_security_group.services` (`rds.tf:45`); re-point it at `aws_security_group.runtime` or the Runtime loses the KB. |
| `redis.tf` | 76 | dies at cutover | Valkey replication group, SGs, `random_password`, `live_redis_url` secret. |
| `cloudwatch.tf` | 295 | mixed, ~90% dies | Log groups + alarms for chat-api / maintenance / publisher / ALB / Redis Live Stream. The `agentcore-runtime` half of the live-stream metric filters targets `/aws/bedrock-agentcore/runtimes/<id>-DEFAULT` but carries Redis semantics; re-author rather than keep. |
| `database-access.tf` | 130 | mixed | Operator psql bridge (EICE + instance + SGs) survives if operator access to the KB is still wanted; the two `*_agent_db` rules die. |
| `artifacts.tf` | 81 | survives | Bucket + PAB + ownership + SSE + versioning + lifecycle + TLS-only policy, unchanged. Also the copy-template for the SessionStore / workspace buckets. |
| `locals.tf` | 125 | mixed, mostly dies | Survive: `common_name`, the `shared_*` derivations, `kb_database_url_secret_name/_arn`. Die: every chat-api / maintenance / publisher / agent-DB / redis / e2b / dispatch local. |
| `outputs.tf` | 173 | mixed, mostly dies | Survive: `kb_database_url_secret_arn`, `artifact_bucket_name`, `alarm_action_arns`, `shared_infra`, `database_access_*`. Die: ECS/ALB/agent-DB/redis/e2b/microvm outputs. |
| `variables.tf` | 381 | mixed | Survive 14 (`aws_region`, `aws_account_id`, `environment`, `name_prefix`, `tags`, `availability_zones`, `private_subnet_cidrs`, `fck_nat_ami_id`, `runtime_image_digest`, `kb_database_security_group_id`, `kb_database_url_secret_name`, `alarm_action_arns`, `log_retention_days`, `log_level`); rename `consumer_lambda_package`; the other ~25 die. |
| `prod.tfvars`, `examples/prod.tfvars.example` | 37 / 53 | mixed | Keep `environment`, `tags`, `kb_database_security_group_id`, `fck_nat_ami_id`, `alarm_action_arns`; the three ECS image URIs + consumer zip collapse to one front-Lambda package. |
| `microvm.tf`, `microvm-image.tf` | 412 / 52 | dying now | Decided at charting. |
| `README.md` | 404 | rewrite | Keep the Runtime image loop (buildx arm64 → smoke check → push → `describe-images` digest → `TF_VAR_runtime_image_digest`), the ECR-repo handoff to `infra/ecr`, the bootstrap-iam gate, MMDSv2/endpoint verification. The migration targeted-plan and `roll_ecs_services.sh` sections go. |

**New (does not exist):** the Lambda front + role + Function URL / API Gateway (neither exists
anywhere in the repo), DynamoDB table(s) (zero `aws_dynamodb_*`), the Code Interpreter
(`aws_bedrockagentcore_code_interpreter` **is present in the locked 6.61.0 provider binary** —
no version bump), the SessionStore + workspace S3 buckets, and the Runtime IAM statements above.
Gate on all of them: `infra/bootstrap-iam/main.tf` grants **no `dynamodb:*`, no
`lambda:*FunctionUrlConfig` / `apigateway:*`, and only the `*AgentRuntime*` /
`CreateWorkloadIdentity` subset of `bedrock-agentcore:*`** — it is operator-applied and must
be extended before the first CI apply (the MicroVM effort hit the same gate on
its first apply).

### Workflows (`.github/workflows`)

| file | component | fate |
|---|---|---|
| `release-deploy.yml` | everything | survives, heavily cut: keep the Runtime image + digest step, `infra/ecr`, plan/apply, MMDSv2 + endpoint verification; delete the three ECS image builds, the migration steps, `roll_ecs_services.sh`, "Detect first ECS service deploy"; the consumer-zip step becomes the front-Lambda zip. |
| `agentcore-runtime-image.yml` | Runtime image PR check | survives; path filters drop `agentcore-dispatch-consumer/**`, `packages/agentcore-dispatch/**`. |
| `agentcore-dispatch-publisher-image.yml` | publisher image | dies at cutover |
| `maintenance-image.yml` | agent-maintenance image | dies at cutover |
| `microvm-image.yml` | MicroVM image | dying now |
| `ci.yml` | test / infrastructure / integration | survives trimmed: the `integration` job's Postgres tests all target the agent DB. |

## What the tables do not say

1. **`agentcore-runtime` is the blocker, not the packages.** It has 24 non-test import sites
   into `@mymemo/agent-db` (9 into `run-store`, 8 into `client`) plus
   `acquisition-boundary` / `contract`. Nothing in `agent-db`, `agentcore-dispatch` or the
   consumer app can be deleted until the Runtime's Run / Ownership / session persistence is
   repointed at DynamoDB and the S3 SessionStore. Sequence: DynamoDB stores first, then the
   deletions fall out.
2. **Rescue the pure contract first, as one commit.** `run-events.ts` + `tool-event-projection.ts`
   (1,372 lines, `zod` only, 1,675 lines of tests) plus `UiNode`'s consumers
   (`ui-payload-validator.ts`, `assistant-message-assembler.ts`) form the generative-UI / tool-event
   contract. Move them to a small `packages/agent-events` and the rest of `agent-db` deletes
   cleanly.
3. **Two streaming sinks become one.** `agent-stream.ts` today writes each envelope twice —
   fenced Postgres `run_events` batches and AG-UI relay events. The target has one UIMessage
   writer on the invocation response plus a history write at Turn end; the assembler's
   `message_stop` commit boundary is the natural point for both. The AG-UI `TEXT_MESSAGE_*`
   coalescer (`ag-ui-text-stream.ts`) has no UIMessage analogue and goes.
4. **The artifact seam is right, the workspace adapter is not.** `ArtifactWorkspace`
   (`captureManifest` / `openFile`) and `ArtifactObjectStore` are the right interfaces; the
   E2B implementation (`artifact-workspace.ts`, 334 lines of Python-over-`commands.run`) is the
   part that dies. On an S3-backed workspace the manifest is a `ListObjectsV2` and the bytes a
   `GetObject` or `CopyObject` — which may make the 279-line streaming S3 store redundant. The
   spec ticket should decide whether artifacts are *copied* or *streamed*.
5. **`toolAliases` changes the tool surface, not the tool bodies.** `file-tools.ts` and
   `bash-tool.ts` are transport-neutral behind `SandboxFileClient` / `SandboxCommandClient`;
   only the E2B clients die. But #708 requires the MCP schemas to mirror the built-in parameter
   names (`file_path`, `old_string` / `new_string`), so `workspace-tools.ts` is a rename pass,
   and `bash-tool.ts`'s group-kill / reap protocol loses its reason (no interrupt) — keep the
   clamp, caps and outcome normalisation.
6. **Three things to carry over before their homes are deleted now**: the ~60 lines of MCP
   wiring in `apps/in-vm-server/src/doc-tools.ts` (in-vm-server is *deleted now*), the two
   PGlite KB-SQL integration tests in `agentcore-runtime/src/documents/`, and the
   `POST /invocations` + session-header detail from the local dispatch bridge for local dev.
7. **Two Terraform traps**: `prevent_destroy` on the four dispatch resources and
   `deletion_protection` on the agent RDS both force two-phase applies, and the KB ingress rule
   is sourced from the ECS `services` SG — re-point it at the `runtime` SG before `network.tf` is
   removed or the Runtime silently loses the KB.
