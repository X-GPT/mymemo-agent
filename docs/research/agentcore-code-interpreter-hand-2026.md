# The AgentCore Code Interpreter as the only hand

**Research date: 2026-09-04.** Resolves
[#721](https://github.com/X-GPT/mymemo-agent/issues/721) for the
[simplified-chat map (#719)](https://github.com/X-GPT/mymemo-agent/issues/719). Sources are
primary only: the AWS Bedrock AgentCore developer guide and API references as read on the
research date, `@aws-sdk/client-bedrock-agentcore` **3.1110.0** (the version installed under
`apps/agentcore-dispatch-consumer/node_modules`), and the pinned Claude Agent SDK
**0.3.251** (`apps/in-vm-server/package.json`; note `apps/agentcore-runtime` still pins
**0.3.233** — the v3 notes and this note read 0.3.251). The earlier v3 findings this note
builds on: [remote-tool transport (#702)](https://github.com/X-GPT/mymemo-agent/issues/702)
and the [hand probe (#708)](https://github.com/X-GPT/mymemo-agent/issues/708).

## Short answer

- **The S3-backed filesystem is real, and its exact name is an *Amazon S3 Files* access-point
  mount.** `StartCodeInterpreterSession` (and `CreateCodeInterpreter`) take
  `filesystemConfigurations[].s3FilesConfiguration{accessPointArn, fileSystemArn, mountPath}`.
  It is an **NFSv4.2 mount, not a copy-in/copy-out**: the session sees the file system at
  `/mnt/<name>`, and S3 Files exports each changed file to the backing bucket as a new object
  version after **~60 s of write inactivity**. Files the model writes therefore survive session
  end with **no sync code of ours** — but a session that dies inside the 60 s window has its
  last writes durable on the S3 Files high-performance tier (regional, S3-durable), not yet
  visible as S3 objects. **Preconditions**: a *custom* Code Interpreter in **`VPC` network
  mode**, an S3 Files file system + mount target + access point in that VPC/AZ, **S3 Versioning
  on the bucket**, `s3files:ClientMount/ClientWrite/GetAccessPoint` on the interpreter's
  execution role, TCP 2049 in the security groups. The system interpreter
  `aws.codeinterpreter.v1` cannot mount anything.
- **Session lifetime**: `sessionTimeoutSeconds` is an **absolute TTL** ("regardless of ongoing
  activity"), default 900 s, max **28,800 s (8 h)**; there is no idle timeout and no resume —
  a stopped/expired session is `TERMINATED` for good. So a session can span the Turns of one
  Conversation only within an 8 h window; the workspace's continuity across days comes from
  the S3 Files mount, not the session. Start latency is **not documented** (probe it).
  Quotas: **1,000 concurrent sessions/account** (adjustable), **30 TPS** on
  `StartCodeInterpreterSession`/`InvokeCodeInterpreter`/`Stop…`, 2 vCPU / 8 GB and 10 GB disk
  per session, 15 min synchronous request timeout, 100 MB payload. Billing is per-second
  active CPU (`$0.0895`/vCPU-h) and peak memory (`$0.00945`/GB-h); "I/O wait and idle time is
  free" — an open idle session costs (at most) its memory.
- **Operations**: one data-plane call, `InvokeCodeInterpreter`, with nine `name`s:
  `executeCode`, `executeCommand`, `startCommandExecution`/`getTask`/`stopTask` (async shell,
  up to 8 h), `readFiles`, `writeFiles`, `listFiles`, `removeFiles`. There is no grep/glob/edit
  primitive: `Grep`/`Glob` are `executeCommand` (`grep -rn`, `find`), `Edit` is
  `readFiles` → string replace in the hand → `writeFiles`. Results come back whole
  (`content[]` + `structuredContent{stdout,stderr,exitCode,executionTime,taskId,taskStatus}`)
  as a one-event stream; the SDK's tool result is not streamed to the model either, so the
  hand caps output itself.
- **SDK wiring**: the MicroVM shape carries over unchanged — `tools: []`, an in-process
  `createSdkMcpServer("hand")` whose handlers call `InvokeCodeInterpreter`, `toolAliases`
  `{Bash, Read, Write, Edit, Glob, Grep → mcp__hand__*}`, schemas mirroring the built-ins'
  parameter names, `permissionMode: 'dontAsk'` + `allowedTools: ['mcp__hand__*']`. The
  Runtime reaches the Code Interpreter over the regional public endpoint
  `bedrock-agentcore.<region>.amazonaws.com` with its **execution role** (SigV4) — no secret,
  no VPC needed on the Runtime side; the VPC lives on the interpreter. Every call is one
  HTTPS round-trip plus sandbox work; no per-call latency figure is published (probe it; the
  MicroVM hand measured 30–200 ms per call, and the transport here is comparable).
- **Still on the Runtime disk**: the CLI's `CLAUDE_CONFIG_DIR` (transcript JSONL under
  `projects/`, the `sessionStore` mirror's required local copy), the CLI binary and its caches,
  `cwd` (CLAUDE.md/skills/hooks discovery — empty for us), and the SDK's >25k-token MCP-result
  spill file. All ephemeral per Runtime microVM; nothing the model can read.

## 1. The S3 Files mount — confirmed

### 1.1 Name and API shape

The feature is **"File system configurations for AgentCore Code Interpreter"**, a
bring-your-own mount of an **Amazon S3 Files** or **Amazon EFS** access point
([devguide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-filesystem-configurations.html)):

> "Each configuration mounts an Amazon S3 Files or Amazon EFS access point at a path you
> specify. You don't need custom mount code, privileged containers, or download orchestration
> — AgentCore performs all mount operations inside the session sandbox."

> "Unlike AgentCore Runtime, AgentCore Code Interpreter does not offer a managed
> session-storage option. Code Interpreter supports bring-your-own Amazon S3 Files and Amazon
> EFS access points only."

The installed client already has the types
(`dist-types/models/models_0.d.ts` in `@aws-sdk/client-bedrock-agentcore` 3.1110.0):

```ts
export interface S3FilesConfiguration {
  accessPointArn: string | undefined;   // arn:aws:s3files:<region>:<acct>:file-system/<fs>/access-point/<ap>
  mountPath: string | undefined;        // e.g. /mnt/s3data — unique per session
  fileSystemArn: string | undefined;    // arn:aws:s3files:<region>:<acct>:file-system/<fs>
}
export type ToolsFileSystemConfiguration =
  | { s3FilesConfiguration: S3FilesConfiguration }
  | { efsConfiguration: EfsConfiguration };
export interface StartCodeInterpreterSessionRequest {
  codeInterpreterIdentifier: string;
  name?: string;
  sessionTimeoutSeconds?: number;
  certificates?: Certificate[];
  filesystemConfigurations?: ToolsFileSystemConfiguration[];
  clientToken?: string;
}
```

`filesystemConfigurations` is accepted at **both** `CreateCodeInterpreter` (control plane —
inherited by every session) and `StartCodeInterpreterSession` (data plane — that session
only); when both are given they are combined and mount paths must be unique. Effective mounts
are visible on `GetCodeInterpreterSession`
([API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_StartCodeInterpreterSession.html),
[CreateCodeInterpreter API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CreateCodeInterpreter.html)).

Limits (devguide "Limits" table): **2 S3 Files access points per `CreateCodeInterpreter`, 2
per `StartCodeInterpreterSession`, 4 combined; 8 total mounts per session**. Mount paths must
match `/mnt/[a-zA-Z0-9._-]+/?` (exactly one level under `/mnt/`), may not nest. "All
configured file systems mount in parallel at session start – a single mount failure causes
the session start to fail."

**Binding a session to a bucket/prefix** happens at the S3 Files layer, not in AgentCore: an
S3 Files *file system* is "linked to your S3 bucket or to a prefix within it", and an *access
point* on it "enforce[s] a POSIX user identity and root directory for all file system
requests" ([S3 Files](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files.html)).
So the per-Conversation isolation choice is either one access point per Conversation (root
directory = the Conversation prefix; AgentCore only sees the access-point ARN) or one shared
access point with the hand confining paths to `/mnt/ws/<conversationId>/`. The access point
quota is 25,000 per file system (S3 Files
[quotas](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-quotas.html)).

### 1.2 Semantics: mount, bidirectional sync, 60-second export window

From the AgentCore devguide: "On session start, AgentCore provisions a sandbox with network
access to your VPC. The sandbox mounts the file system through NFSv4.2 over TLS with IAM
authentication (port 2049) via your VPC. Your agent reads and writes files at the mount
path. Changes automatically sync to the backing S3 bucket."

From the S3 Files guide
([synchronization](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-synchronization.html),
[performance](https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-performance.html)):

- "S3 Files requires S3 Versioning to be enabled on the linked S3 bucket." Edits become new
  object versions; deletes become delete markers.
- "Writes go to the high-performance storage and are durable immediately." Then: "When a
  file is modified on the file system, S3 Files waits for a period of write inactivity (60
  seconds) before exporting those changes back to your S3 bucket." Export rate up to 800
  files/s and 2,700 MB/s per file system; pending exports are queued in order
  (`PendingExports` CloudWatch metric).
- Reads: first access to a directory imports metadata for all files in it (and data for
  files < 128 KiB by default) — "This initial listing may take several seconds"; large reads
  (≥ 1 MiB) stream straight from S3.
- Bucket-side changes appear in the file system "typically within seconds" (S3 Event
  Notifications) for files whose data is resident; expired files are refreshed on next access.
- Conflicts (same file changed on both sides before export): "S3 Files considers the S3
  bucket as the source of truth"; the file-system version is moved to
  `.s3files-lost+found-<fs-id>` at the file-system root (above any access-point root, so
  invisible from the mount).
- Renames are instant on the mount but are copy+delete per object on the bucket.
- File-system semantics: NFSv4.1/4.2, "read-after-write data consistency, file locking, and
  POSIX permissions"; the AgentCore Runtime page phrases it as "Close-to-open consistency for
  NFS clients; S3 eventual consistency for bucket-side access".
- Not supported: hard links, path components > 255 bytes, keys > 1,024 bytes, Glacier
  classes, S3 ACLs. Max file size 48 TiB. POSIX bits are stored as user-defined object
  metadata.
- Unused data expires from the high-performance tier after 30 days (1–365 configurable);
  metadata never expires; the bucket stays authoritative.

**Consequences for MyMemo**

- "Do the model's files survive session end without our own sync?" — **Yes.** The mount is
  the workspace; nothing is copied in or out by us. The only window is the 60 s export delay:
  a file written 10 s before the session dies is durable (S3-grade, multi-AZ) on the file
  system and *will* be exported, but the Lambda front reading the **bucket** with plain S3
  GETs at that moment sees the previous version. Anything that reads the workspace through the
  S3 API (artifact download, generative-UI catalog reads) must tolerate that lag or read
  through the mount (the next session's `readFiles`).
- The bucket must have Versioning on — S3 lifecycle rules for noncurrent versions become
  part of the Terraform inventory.
- Small files (the workspace's typical shape) live on the high-performance tier at
  `$0.30`/GB-month plus `$0.06`/GB write, `$0.03`/GB read, `$0.03`/GB export
  ([S3 pricing](https://aws.amazon.com/s3/pricing/), S3 Files section). Negligible at
  workspace scale; the 30-day expiry keeps it bounded.
- Everything here is "customer-managed (permanent, syncs to the backing S3 bucket)" — the
  Conversation delete path must delete the prefix (and versions) itself.

### 1.3 Preconditions the spec must carry

From the devguide ("Prerequisites", "Quick start"):

1. "Your code interpreter must use `VPC` network mode. The subnets you specify must overlap
   with the file system mount target Availability Zones." Valid modes are
   `PUBLIC | SANDBOX | VPC`
   ([API](https://docs.aws.amazon.com/bedrock-agentcore-control/latest/APIReference/API_CodeInterpreterNetworkConfiguration.html));
   `vpcConfig{subnets, securityGroups, requireServiceS3Endpoint}`. Supported AZ IDs in
   us-west-2 (the prod region per `infra/terraform`): `usw2-az1 usw2-az2 usw2-az3`
   ([VPC guide](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agentcore-vpc.html)).
2. A VPC-mode interpreter "does not have internet access by default" — `pip install`,
   `npm install`, `curl` need a NAT gateway; S3 API access needs an S3 gateway endpoint or NAT.
   Decide whether the hand's `Bash` gets egress at all (the MicroVM design had none).
3. Execution role (trust `bedrock-agentcore.amazonaws.com`, `aws:SourceAccount`/`SourceArn`
   conditions) with `s3files:ClientMount`, `s3files:ClientWrite`, `s3files:GetAccessPoint` on
   the file-system ARN, conditioned on `s3files:AccessPointArn`. `executionRoleArn` is
   optional on `CreateCodeInterpreter` in general but required here.
4. Security groups: interpreter SG egress TCP 2049 → mount-target SG; mount-target SG ingress
   TCP 2049 from the interpreter SG. One mount target per AZ, same VPC, DNS resolution on.
5. Access point UID/GID: "All file operations through the access point run as this
   identity" — must match the sandbox user, which is **not documented** (the Runtime page
   suggests 1000:1000 or 0:0). Probe: `executeCommand` `id` on the system interpreter.
6. Region: the 2026-05 Runtime release note says BYO file systems are "available across all
   15 AWS Regions where AgentCore Runtime is supported"; the Code Interpreter page has no
   region caveat. S3 Files itself must exist in us-west-2 — its performance page says write
   throughput is "1–5 GiB/s depending on the region", i.e. multi-region; verify in the console
   during the Terraform ticket.
7. Custom interpreters are ARN `…:code-interpreter-custom/<name>-<10 chars>` (from the
   `codeInterpreterArn` pattern) — an IAM policy scoped to `code-interpreter/*` (as in the
   devguide sample) would **not** match a custom one; scope to `code-interpreter-custom/*` too.

### 1.4 The alternatives, for the record

- **EFS access point** — same API shape (`efsConfiguration`), NFSv4.1, no bucket, "permanent
  until you delete it". Cheaper writes, no 60 s export, but then the workspace is *not* in S3
  and the Lambda front cannot read artifacts with an S3 GET. Rejected by the map's premise
  ("one S3-backed place").
- **Execution-role S3 via `aws s3 cp` in `executeCommand`** (SANDBOX mode, up to 5 GB per
  object per the [tool page](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html))
  — the pre-mount way; that is our own copy-in/copy-out and exactly what the map wants to
  delete.
- **AgentCore Runtime managed session storage** (Preview, 1 GB, 14-day idle expiry, wiped on
  version update) and Runtime-side S3 Files mounts exist too
  ([runtime page](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html)),
  but the map already chose remote file tools; noted only because a Runtime-side S3 Files
  mount would let the SDK's built-in file tools run against the same bucket with zero hand
  code — a different design, not evaluated here.

## 2. Session lifetime and quotas

From the [session management](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-session-characteristics.html)
page and the `StartCodeInterpreterSession` API reference:

| Property | Value | Source |
| --- | --- | --- |
| `sessionTimeoutSeconds` | "duration in seconds (time-to-live) after which the session automatically terminates, **regardless of ongoing activity**. Defaults to 900 seconds (15 minutes). Recommended minimum: 60 seconds. Maximum allowed: 28,800 seconds (8 hours)." Range 1–28800. | API ref, client types |
| Idle timeout | None documented — TTL only. | — |
| States | `READY` / `TERMINATED` (client enum); docs also say "ACTIVE, STOPPING, STOPPED" on `GetCodeInterpreterSession`. | `enums.d.ts`, `models_0.d.ts` |
| Resume after stop/expiry | Not offered. `InvokeCodeInterpreter`: "If the session has expired or been stopped, the request will fail." | API ref |
| Session persistence | "Files and data created during a session are available throughout the session's lifetime. When the session is terminated, the session no longer persists and the data is cleaned up." (the ephemeral 10 GB disk; the S3 Files mount is unaffected). | devguide |
| Retention of session *records* | 30-day TTL. | devguide |
| Isolation | "Each tool session runs in a dedicated microVM with isolated CPU, memory, and filesystem resources … Upon session completion, the microVM is fully terminated, and its memory is sanitized." | devguide |
| Multiple sessions per interpreter | Yes, each with its own state. | devguide |
| Start latency | **Not documented.** | — |
| Concurrency | **1,000 concurrent active sessions per account** (adjustable via support). | [quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html) |
| Hardware | 2 vCPU / 8 GB, 10 GB disk per session. | quotas |
| Sync request timeout | 15 min; async command max 8 h; payload 100 MB. | quotas |
| TPS | 30 TPS each on `StartCodeInterpreterSession`, `InvokeCodeInterpreter`, `StopCodeInterpreterSession`, `Get…`, `List…`; 5 TPS `CreateCodeInterpreter`. All adjustable. | quotas |
| Pricing | `$0.0895` per vCPU-hour, `$0.00945` per GB-hour, per-second, 1 s minimum; "I/O wait and idle time is free, if no other background process is running"; memory billed on peak per second. | [pricing](https://aws.amazon.com/bedrock/agentcore/pricing/) |

Reading the TTL rule against the map: a Conversation lives for days; a session lives ≤ 8 h
and cannot be resumed. So **the session is a Turn-scoped (or Runtime-session-scoped)
resource and the S3 Files mount is the Conversation-scoped one.** The 30 TPS
`InvokeCodeInterpreter` quota is account-wide: at ~6 hand calls per Turn (the #708 number) it
bounds us at roughly 5 Turns/s before a raise — fine for now, worth a line in the alarms.

Errors worth handling by name (API ref): `ThrottlingException` 429, `ConflictException` 409,
`ResourceNotFoundException` 404 (expired session), `ServiceQuotaExceededException` 402,
`InternalServerException` 500 ("retry with exponential backoff"). They arrive both as HTTP
errors and as members of the response `stream` union (`CodeInterpreterStreamOutput`).

## 3. Operations

`InvokeCodeInterpreter` (`POST /code-interpreters/{id}/tools/invoke`, session in the
`x-amzn-code-interpreter-session-id` header) with `name` ∈
`executeCode | executeCommand | readFiles | listFiles | removeFiles | writeFiles |
startCommandExecution | getTask | stopTask` and a single flat `arguments` bag
(`ToolArguments` in the client: `code, language, clearContext, command, path, paths,
content[{path, text | blob}], directoryPath, taskId, runtime`)
([API](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeCodeInterpreter.html),
[examples](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-api-reference-examples.html)).

| Need | Call | Notes |
| --- | --- | --- |
| Bash | `executeCommand {command}` | Synchronous; bounded by the 15 min request timeout; `structuredContent.exitCode/stdout/stderr/executionTime`; `CommandExecutionStatus` has `TIMED_OUT`. |
| Long Bash | `startCommandExecution {command}` → `getTask {taskId}` / `stopTask {taskId}` | `TaskStatus` `submitted / working / completed / failed / canceled`; up to 8 h. Polling is ours. |
| Read | `readFiles {paths[]}` | Returns `content[]` blocks (`text` / `resource` with `blob`+`mimeType`); no offset/limit — the hand slices. |
| Write | `writeFiles {content:[{path, text|blob}]}` | Creates parent dirs (`dir1/samename.txt` in the docs); inline up to 100 MB. |
| Edit | `readFiles` → replace in the hand → `writeFiles` | No edit primitive. The MicroVM hand did exactly this. |
| Glob | `executeCommand "find …"` or `listFiles {directoryPath}` (one level) | |
| Grep | `executeCommand "grep -rn …"` | `ripgrep` presence is not documented; `grep` is a shell builtin of any Linux image. |
| Delete | `removeFiles {paths[]}` | |
| Python/JS eval | `executeCode {code, language: python|javascript|typescript, runtime: python|nodejs|deno, clearContext}` | State is kept between calls unless `clearContext`. Not needed for the hand. |

Undocumented, to probe once: the session's working directory and user (docs use relative
paths like `data.csv`; `listFiles {path: ""}` lists the root of the work dir), whether the
mount path is usable as `cwd` for `executeCommand` (`cd /mnt/ws && …` works regardless), and
per-call latency. The tool page lists "internet access" as a feature of the *system*
interpreter; a VPC-mode custom one has none without NAT.

**Output bounds.** No documented cap on `stdout` besides the 100 MB payload; the response is
"a stream" but in practice one `result` event per call (the docs' examples `return` on the
first event). On the SDK side, #702 established that tool results are returned whole and that
results over ~25k tokens are spilled to a file on the CLI host with an error naming the path —
unrecoverable without a local `Read`. The hand keeps the MicroVM policy: cap at 64 KiB with
`truncated: true`, per-call timeout, path confinement under the mount.

**Pre-installed toolchain** ([libraries](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-preinstalled-libraries.html)):
Python with pandas/numpy/matplotlib/…, Node.js with axios/lodash/uuid/zod/cheerio, the AWS
CLI (used in the S3 sample). Nothing about git; the sandbox image is not ours to change.

## 4. Wiring into the Claude Agent SDK 0.3.251

### 4.1 Same shape as the MicroVM hand

Verified in `sdk.d.ts` / `sdk.mjs` of the pinned package:

- `tools?: string[] | {type:'preset', preset:'claude_code'}` — "`[]` (empty array) - Disable
  all built-in tools"; the CLI is spawned with `--tools ""`.
- `toolAliases?: Record<string,string>` — "a host that runs Bash inside a remote sandbox via
  an MCP tool can set `{ Bash: 'mcp__workspace__bash' }` … the call is routed to the MCP tool
  instead of failing as unknown." Single-hop; sent in the `initialize` control request
  (`toolAliases:this.initConfig?.toolAliases` in `sdk.mjs`). "`toolAliases` is complementary
  to `disallowedTools`, not a replacement for it: the alias only affects name-based lookup of
  model-emitted `tool_use` blocks, whereas `disallowedTools` also blocks harness-internal
  direct calls that hold the tool object without a name lookup."
- `createSdkMcpServer({name, version, tools, alwaysLoad})` — in-process MCP; `alwaysLoad`
  keeps the tools out of deferred tool search.
- `permissionMode: 'dontAsk'` + `allowedTools: ['mcp__hand__*']` — locked-down posture from
  #702; `canUseTool` never fires.

The built-ins that exist to alias (`sdk-tools.d.ts` `ToolInputSchemas`): `Agent, Bash,
TaskOutput, ExitPlanMode, FileEdit (Edit), FileRead (Read), FileWrite (Write), Glob, Grep,
TaskStop, ListMcpResources, RefreshMcpTools, Mcp, NotebookEdit, ReadMcpResourceDir,
ReadMcpResource, ReportFindings, TodoWrite, WebFetch, WebSearch, AskUserQuestion,
SendFeedback, ClaudeDesign, Projects, EnterPlanMode, TaskCreate/Get/Update/List`. With
`tools: []` none of them is offered, so aliasing only matters for names the model emits from
memory or a skill document — `Bash`, `Read`, `Write`, `Edit`, `Glob`, `Grep` cover that.
`NotebookEdit`, `TaskOutput`/`TaskStop` (background Bash) have no remote counterpart and
stay unaliased (an emitted call fails as unknown, which is the right outcome). Nothing in the
type says a built-in *cannot* be aliased; the "cannot be aliased" set is really the
harness-internal direct calls the comment mentions, which `tools: []` already removes.

Schemas must mirror the built-ins' parameter names because the alias routes by name only
(#708). The 0.3.251 shapes to mirror:

```ts
BashInput      { command: string; timeout?: number; description?: string; run_in_background?: boolean }
FileReadInput  { file_path: string; offset?: number; limit?: number }
FileWriteInput { file_path: string; content: string }
FileEditInput  { file_path: string; old_string: string; new_string: string; replace_all?: boolean }
GlobInput      { pattern: string; path?: string }
GrepInput      { pattern: string; path?: string; glob?: string; output_mode?: 'content'|'files_with_matches'|'count'; … }
```

### 4.2 Network, credentials, latency

- **Endpoint**: data plane `https://bedrock-agentcore.<region>.amazonaws.com` (us-west-2
  listed) ([endpoints](https://docs.aws.amazon.com/general/latest/gr/bedrock_agentcore.html)).
  The client resolves it itself. A Runtime in `PUBLIC` network mode reaches it directly; a
  `VPC`-mode Runtime "does not have internet access by default" and would need NAT — the VPC
  guide mentions an AgentCore PrivateLink endpoint for *inbound* Runtime/Gateway API calls
  only, so a Code Interpreter data-plane VPC endpoint is **not confirmed**. Keep the Runtime
  in `PUBLIC` mode; the VPC requirement is on the interpreter, not the caller.
- **Credentials**: plain SigV4 with the Runtime's execution role — add
  `bedrock-agentcore:StartCodeInterpreterSession`, `InvokeCodeInterpreter`,
  `StopCodeInterpreterSession`, `GetCodeInterpreterSession` on the custom interpreter ARN
  (`code-interpreter-custom/<id>`) to the Runtime role
  ([IAM sample](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-resource-session-management.html)).
  No application secret, no token minting, no JWE — simpler than the MicroVM hand. The
  interpreter's own execution role is a second, separate role (mount permissions).
- **Latency**: not published. One HTTPS request per hand call; `executeCommand` adds process
  spawn inside the sandbox. Probe before the spec fixes numbers; the #708 figures
  (30–200 ms file ops, ~3 s first spawn) are the prior.
- **Client**: `@aws-sdk/client-bedrock-agentcore` (already a dependency at 3.1110.0) has
  `StartCodeInterpreterSessionCommand`, `InvokeCodeInterpreterCommand` (response `stream:
  AsyncIterable<CodeInterpreterStreamOutput>`), `StopCodeInterpreterSessionCommand`,
  `GetCodeInterpreterSessionCommand`, `ListCodeInterpreterSessionsCommand`. Creating the
  interpreter is control-plane (`@aws-sdk/client-bedrock-agentcore-control`, not installed) —
  do it in Terraform/CLI, not at run time. `clientToken` on start/stop makes them idempotent.

## 5. What still touches the Runtime disk

With every file tool and Bash remote, the Runtime microVM's ephemeral disk still carries:

1. **The CLI's `CLAUDE_CONFIG_DIR`** (default `~/.claude`, resolved in `sdk.mjs`): session
   transcripts under `projects/<cwd-hash>/<sessionId>.jsonl` (+ `subagents/`), settings,
   caches, debug logs. `persistSession: false` (`--no-session-persistence`) stops the
   transcript writes but "cannot be used with `sessionStore`" — the S3 SessionStore chosen in
   #703 *requires* the local copy ("the mirror hook fires after local write success"; "set
   `CLAUDE_CONFIG_DIR=/tmp` for ephemeral local copy"). Resume materialises from
   `sessionStore.load()` into that directory (`sessionStoreLoadTimeout`). Treat it as a
   cache: point it at `/tmp`, size it against the Runtime's disk, never rely on it across
   Runtime sessions (the Runtime microVM is torn down after 15 min idle / 8 h max, default —
   [lifecycle](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)).
2. **`cwd`** — the CLI still reads CLAUDE.md, `.claude/` skills/hooks/settings from it and
   hashes it into the transcript path. Use a fixed empty directory so the project key is
   stable (`sdk.d.ts` on `importSessionToStore`: "the destination projectKey is derived from
   the resolved cwd").
3. **The >25k-token MCP result spill** (#702) — written next to the transcript; unreadable by
   the model since `Read` is remote. The hand's output cap keeps it from ever happening.
4. The CLI binary itself and whatever the container image ships. Nothing user-visible: the
   model has no tool that can read the Runtime disk, which is the point.

## 6. Recommended tool surface and session policy

**Tool surface** (in-process `createSdkMcpServer("hand", { alwaysLoad: true })`, mirrored
schemas, `toolAliases` for the six built-in names):

| Tool | Backed by | Policy in the hand |
| --- | --- | --- |
| `bash` (`command`, `timeout?`) | `executeCommand`, prefixed `cd /mnt/ws && ` | 64 KiB cap + `truncated`, default timeout ≤ 120 s (hard ceiling well under the 15 min request timeout), no `run_in_background` (drop `startCommandExecution` for v1). |
| `read` (`file_path`, `offset?`, `limit?`) | `readFiles` | Path confined to the mount root; line slicing in the hand; binary → size + mime only. |
| `write` (`file_path`, `content`) | `writeFiles` | Confined; size cap. |
| `edit` (`file_path`, `old_string`, `new_string`, `replace_all?`) | `readFiles` → replace → `writeFiles` | Uniqueness check on `old_string` like the built-in; no read-before-edit state (the CLI's `readFileState` does not apply to MCP tools — #702). |
| `glob` (`pattern`, `path?`) | `executeCommand find` | Result cap. |
| `grep` (`pattern`, `path?`, `glob?`, `output_mode?`) | `executeCommand grep -rn` | Result cap. |

Runner-only (never in the model's tool list): none needed. Artifact export and workspace
inspection read the **bucket** through the S3 API from the Lambda front, accepting the ≤ 60 s
export lag — or, when freshness matters, `readFiles` through the live session.

**Session policy**

- One custom Code Interpreter (VPC mode, execution role with the S3 Files mount grants),
  created by Terraform; one S3 Files file system on the workspace bucket (Versioning on) with
  a mount target per used AZ.
- **Session per Turn**: `StartCodeInterpreterSession` at Turn start with
  `filesystemConfigurations` naming the Conversation's access point (or the shared one) at
  `mountPath: /mnt/ws`, `sessionTimeoutSeconds` = the Turn's ceiling (e.g. 1800; hard max
  28800), `clientToken` = Turn id; `StopCodeInterpreterSession` in a `finally`. Rationale:
  the TTL is absolute and unresumable, so keeping a session alive across Turns only buys the
  start latency (unmeasured) at the cost of a per-Conversation session registry and reaper —
  the machinery the map is deleting. If the probe shows start latency that hurts, upgrade to
  **session per Runtime session** (start lazily on first hand call, stop on Runtime session
  end/idle, sessionId held in the Runtime process only, `ResourceNotFound` on invoke → start a
  new one) — still no registry in DynamoDB.
- Idle cost is bounded: the docs say idle sessions are free of CPU charge, and a stopped
  session costs nothing; the S3 Files tier costs cents per GB-month and self-expires.
- Concurrency: 1,000 sessions/account and 30 TPS invoke are the first quotas to watch; a
  session-per-Turn policy means concurrent sessions ≈ concurrent Turns.
- Delete Conversation = delete the prefix (all versions) in the bucket; the mount reflects it
  within seconds.

## 7. Open items for the probe / spec

- Session start latency and per-call latency on `executeCommand`/`readFiles`/`writeFiles`.
- Sandbox user UID/GID and working directory (needed to set the access-point POSIX identity).
- Whether S3 Files is available in us-west-2 today and its mount-target AZ set matches the
  AgentCore-supported AZs (`usw2-az1/az2/az3`).
- Whether the hand's `bash` should have egress (NAT) at all; a VPC-mode interpreter has none
  by default.
- Behaviour on a mount failure (`StartCodeInterpreterSession` fails, session never `READY`)
  and on the 60 s export window vs. the Lambda front's artifact reads.
- The `agentcore-runtime` app pins SDK 0.3.233; the hand needs 0.3.251's `toolAliases`
  (undocumented but present and proven in #708) — bump when the Turn-execution ticket lands.
