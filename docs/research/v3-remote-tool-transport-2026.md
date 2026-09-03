# Remote tools for the v3 hand: SDK surface and the MicroVM endpoint

**Research date: 2026-09-03.** Resolves
[#702](https://github.com/X-GPT/mymemo-agent/issues/702) for the
[v3 wayfinder map (#701)](https://github.com/X-GPT/mymemo-agent/issues/701); the design
baseline is
[doc §15](https://github.com/X-GPT/mymemo-agent/blob/research/v3-design-doc/docs/research/v3-claude-managed-agent-aws-architecture-2026.md#15-claude-agent-sdk-与-lambda-microvm-的边界)
(SDK loop in the trusted Runner, MicroVM as the hand).

Versions read: `@anthropic-ai/claude-agent-sdk` **0.3.251** (bundled CLI **2.1.251**,
`manifest.json`) — the pin in
[`apps/in-vm-server/package.json`](../../apps/in-vm-server/package.json) — and the npm
`latest`, **0.3.259** (CLI 2.1.259), installed side by side and diffed. Docs pages are
undated; the TypeScript reference says it describes SDK v0.3.191/CLI 2.1.191 with per-feature
version notes. AWS pages carry no version; the API is `lambda-microvms-2025-09-09`.

Evidence classes used below: **[docs]** = an official page; **[types]** = the installed
`sdk.d.ts` / `sdk-tools.d.ts` / `sdk.mjs` (what the pin actually ships, documented or not);
**[repo]** = this repository's code and measured facts; **[unknown]** = not found in any
primary source.

## Short answer

- **Disabling built-ins is first-class and documented.** `tools: []` removes every built-in
  from the model's context ("Claude can only use your MCP tools"); a bare name in
  `disallowedTools` removes that one tool; a scoped rule (`Bash(rm *)`) leaves it visible and
  denies matching calls. `tools`/bare-deny are the *availability* layer; `allowedTools` and
  scoped denies are the *permission* layer. [docs]
- **The pin already ships a remote-sandbox hook the docs do not mention:**
  `Options.toolAliases` — the type comment's own example is
  `{ Bash: 'mcp__workspace__bash' }` for "a host that runs Bash inside a remote sandbox via an
  MCP tool", so a `Bash` the model emits anyway (a skill said so) is routed to the MCP tool
  instead of failing. It is "complementary to `disallowedTools`, not a replacement". [types]
- **In CLI 2.1.251 `BashOutput` and `KillShell` are legacy aliases** of `TaskOutput` and
  `TaskStop` (`sdk.mjs` alias map). v2's `disallowedTools` names the old names. [types]
- **Remote MCP transports: `stdio`, `sse`, `http` (streamable HTTP), and in-process `sdk`.**
  No WebSocket MCP transport exists in the types or the docs. Remote servers take static
  `headers`, a per-server `timeout`, and `alwaysLoad`. [docs][types]
- **Tool results are returned whole.** A handler returns one `CallToolResult`; there is no
  partial-result path to the model. `tool_progress` messages carry `elapsed_time_seconds`
  and a heartbeat, not output. MCP results over **25,000 tokens** are spilled to a file on the
  CLI host and replaced by an error naming the path — a fallback that presumes a local `Read`.
  [docs][types]
- **The MicroVM endpoint supports HTTP/1.1, HTTP/2, WebSockets, gRPC and SSE**, TLS always,
  one endpoint per VM, public by default (PrivateLink optional). Auth is a JWE in
  `X-aws-proxy-auth` scoped to VM + ports + expiry (**1–60 min**, no revocation); WebSocket
  clients pass it as a subprotocol. Port via `X-aws-proxy-port` (default 8080). [docs]
- **Not documented anywhere:** endpoint request/response body caps, per-request or idle
  timeouts, what happens to an in-flight request or open WebSocket on suspend, whether an
  open long-lived connection counts as "traffic" for the idle policy. Only bandwidth
  (1–16 MB/s by VM size) and per-VM connection/RPS quotas are published. [unknown]
- **No AWS sample does "loop outside, tool calls in through the endpoint".** The Claude
  Managed Agents sample inverts the direction (the VM *pulls* work from Anthropic outbound);
  the Claude Code sample runs the whole CLI inside the VM (v2's shape). [docs]

## 1. Disabling built-in tools

### Mechanisms

| Option | Layer | Effect (verbatim where quoted) | Source |
| :-- | :-- | :-- | :-- |
| `tools: ["Read", "Grep"]` | availability | "Only the listed built-ins are in Claude's context. Unlisted built-ins are removed. MCP tools are unaffected." | [custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools) |
| `tools: []` | availability | "All built-ins are removed. Claude can only use your MCP tools." | same |
| `disallowedTools: ["Bash"]` | availability | "The `Bash` tool definition is removed from the request. Claude does not see the tool and cannot attempt it." | [permissions](https://code.claude.com/docs/en/agent-sdk/permissions) |
| `disallowedTools: ["Bash(rm *)"]` | permission | tool stays visible; matching calls denied "in every permission mode, including `bypassPermissions`" | same |
| `disallowedTools: ["*"]` / `["mcp__*"]` | availability | deny rules accept tool-name globs; `mcp__*` removes every MCP tool | same |
| `allowedTools` | permission | pre-approves; "does not restrict Claude to only these tools" | [typescript](https://code.claude.com/docs/en/agent-sdk/typescript) |
| settings `permissions.deny` / `managedSettings` | permission | same rule syntax via the settings layers; `managedSettings` is "filtered restrictive-only" | [types] `sdk.d.ts` `Settings.permissions`, `Options.managedSettings` |

Type shape of `tools` in 0.3.251: `string[] | { type: 'preset'; preset: 'claude_code' }`, with
the note "native builds may provide search via Bash `find`/`grep` instead of the dedicated
Grep/Glob tools. List Grep/Glob here or in `allowedTools` to get them." [types]

`disallowedTools` "also blocks harness-internal direct calls that hold the tool object
without a name lookup", which `toolAliases` does not — hence "complementary". [types]

### Tool names in this CLI

`sdk-tools.d.ts` (2.1.251) lists `BashInput`, `TaskOutputInput`, `TaskStopInput`,
`FileReadInput`, `FileEditInput`, `FileWriteInput`, `GlobInput`, `GrepInput`,
`WebFetchInput`, `WebSearchInput`, `NotebookEditInput`, `AgentInput`, … The runtime alias
map in `sdk.mjs` is:

```
{Task:"Agent", KillShell:"TaskStop", KillBash:"TaskStop", AgentOutputTool:"TaskOutput",
 BashOutputTool:"TaskOutput", AgentOutput:"TaskOutput", BashOutput:"TaskOutput", …}
```

`TaskStopInput.shell_id` is marked "Deprecated: use task_id instead". So the v2 list in
[`query-options.ts`](../../apps/in-vm-server/src/query-options.ts) (`Bash`, `BashOutput`,
`KillShell`, `WebFetch`, `WebSearch`) names two legacy aliases. Whether the alias map is
applied to `disallowedTools` entries as well as to model-emitted `tool_use` names is
**[unknown]** — the docs list `BashOutput`/`KillShell` as valid names, the types resolve them
as aliases. v3 should simply pass `tools: []` and not depend on the answer.

### Permission mode for a fixed tool surface

Evaluation order (documented): hooks → deny rules → ask rules → permission mode → allow
rules → `canUseTool`. "For a locked-down agent, pair `allowedTools` with
`permissionMode: "dontAsk"`" — listed tools run, "anything else is denied outright instead
of prompting", and `canUseTool` "is never called".
([permissions](https://code.claude.com/docs/en/agent-sdk/permissions)) Allow-rule globs are
only accepted "after a literal `mcp__<server>__` prefix" (`mcp__hand__*` is fine; bare
`mcp__*` or `*` "is ignored with a startup warning"). `PreToolUse` hooks run before every
other step, can `deny`, and can rewrite the call via `updatedInput` (types:
`PreToolUseHookSpecificOutput.updatedInput`). 0.3.259 adds `permissionPrompts: 'none'`
("nobody" answers prompts; `canUseTool` is never called) — the same posture as `dontAsk`
expressed as a separate switch [types, 0.3.259 diff]. `permissionMode` values in the pin:
`default | acceptEdits | bypassPermissions | plan | dontAsk | auto`. [types]

### Does the model lose anything when `Read`/`Edit` become MCP tools?

Three documented differences between a built-in and a same-named MCP tool:

1. **Read-before-edit tracking.** The built-in `Edit` requires a prior `Read` of the file
   (or a `cat`/`sed -n`/`grep`-style Bash view) in the conversation
   ([tools-reference](https://code.claude.com/docs/en/tools-reference): "Read-before-edit:
   Claude reads the file in the current conversation before editing it"). The CLI keeps a
   `readFileState` cache with mtimes; the SDK even has a `seed_read_state` control request to
   repopulate it "when a prior Read was removed from context so Edit validation would fail"
   [types]. Nothing states whether an `mcp__x__Read` participates. With `tools: []` the
   check simply does not exist for the MCP replacements — the hand server must decide
   whether to reimplement stale-write protection. **[unknown]** whether prompt-level
   guidance about Read/Edit still fires when the built-ins are absent.
2. **Tool search deferral.** "Tool search is on by default and defers SDK MCP tools: Claude
   sees each tool's name in a compact list and loads its full schema on demand."
   ([custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools)). Built-ins are
   always in the prompt; the replacements are deferred unless `alwaysLoad: true` is set on
   the tool or server (`createSdkMcpServer({ alwaysLoad })`, `tool(…, { alwaysLoad })`,
   `McpHttpServerConfig.alwaysLoad`) [types]. The `alwaysLoad` side effect: "blocks startup
   until the server is connected (capped at the standard 5s connect timeout)" [types].
3. **Parallelism.** MCP tools are only batched with other read-only calls when annotated
   `readOnlyHint: true`; "Annotations are metadata, not enforcement."
   ([custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools))

Qualitative degradation of the model's tool use (does Claude edit worse through
`mcp__hand__edit` than through `Edit`?) is **[unknown]** — no primary source measures it;
it is a prototype question.

## 2. MCP transports for remotely served tools

### What the pin accepts

`McpServerConfig = McpStdioServerConfig | McpSSEServerConfig | McpHttpServerConfig |
McpSdkServerConfigWithInstance` [types]. Fields:

| Type | Fields | Notes |
| :-- | :-- | :-- |
| `stdio` | `command`, `args`, `env`, `timeout`, `alwaysLoad` | local process next to the CLI |
| `sse` | `url`, `headers`, `tools[]` policy, `timeout`, `alwaysLoad` | legacy SSE transport |
| `http` | same as `sse` | streamable HTTP; `"streamable-http"` accepted only in JSON config, "the SDKs' `McpHttpServerConfig` type declares only `"http"`" ([mcp](https://code.claude.com/docs/en/agent-sdk/mcp)) |
| `sdk` | `name`, `instance: McpServer`, `timeout` | in-process; "runs in-process inside your application, not as a separate process" |

There is no `ws`/WebSocket MCP transport in the types or on the MCP page. A
`claudeai-proxy` type exists in `McpServerStatusConfig` but is not accepted in
`Options.mcpServers` [types].

`headers` are a static `Record<string,string>` set at registration. Servers can be swapped at
runtime via the `mcp_set_servers` control request (`Query.setMcpServers`), and the per-server
`timeout` "Applies when the server is first registered; changing it for an already-registered
server has no effect until it is removed and re-added" [types]. Remote-server startup:
`MCP_TIMEOUT` 30 s connect deadline; a remote server with a cached tool list "connects on its
first tool call"; after a mid-session drop the CLI reconnects up to five times, then reports
`failed` ([mcp](https://code.claude.com/docs/en/agent-sdk/mcp)).

`strictMcpConfig: true` makes `options.mcpServers` the only source, as v2 already does
[repo][types].

### Do tool results stream?

No. A tool handler "must return an object with `content` (required): an array of result
blocks" of type `text | image | audio | resource | resource_link`, plus optional
`structuredContent` and `isError` ([custom-tools](https://code.claude.com/docs/en/agent-sdk/custom-tools));
the type is MCP's `CallToolResult` (`handler: … => Promise<CallToolResult>`) [types]. The
only progress signal is the SDK stream's `tool_progress` message —
`{ tool_use_id, tool_name, elapsed_time_seconds, heartbeat? … }` — with no output payload
[types]; the `streaming-vs-single-mode` page does not mention it at all [docs]. MCP progress
notifications are acknowledged only as *not* extending the timeout: "Hard wall-clock limit
per call; progress notifications do not extend it" [types].

Consequence for §15's "Streamed Tool Result" arrow: streaming can exist between the VM and
the Runner (for the UI's live stdout and for cancellation), but the **model** receives the
tool result only once, whole, when the handler resolves.

### Size and time limits on tool results

| Limit | Value | Source |
| :-- | :-- | :-- |
| MCP result cap | "larger than 25,000 tokens, the full output is saved to a file and the tool result is replaced with an error message that names the file path, so the agent can read the output back in portions"; raise with `MAX_MCP_OUTPUT_TOKENS` | [mcp](https://code.claude.com/docs/en/agent-sdk/mcp) |
| Per-tool override | `_meta["anthropic/maxResultSizeChars"]`, "up to a hard ceiling of 500,000 characters" | [Claude Code MCP page](https://code.claude.com/docs/en/mcp) via the SDK page's link |
| Warning threshold | 10,000 tokens (Claude Code warning) | same page (summarised fetch — verify before quoting a number) |
| Built-in Bash output | `BASH_MAX_OUTPUT_LENGTH` "default: 30000; maximum: 150000" characters | [env-vars](https://code.claude.com/docs/en/env-vars) |
| Built-in Bash timeout | `timeout` "max 600000" ms per call | [types] `BashInput` |
| MCP tool-call timeout | per-server `timeout` (ms, ≥1000) else `MCP_TOOL_TIMEOUT`; in-process default "effectively unbounded" | [types] `createSdkMcpServer` |
| MCP connect | `MCP_TIMEOUT` 30 s; `MCP_CONNECT_TIMEOUT_MS` startup cap 5 s | [mcp](https://code.claude.com/docs/en/agent-sdk/mcp) |

Two unresolved doc conflicts: a summarised fetch of the env-vars page reported
`MAX_MCP_OUTPUT_TOKENS` default 8,000 and `MCP_TOOL_TIMEOUT` default 120,000 ms, against the
MCP page's direct 25,000-token quote and the types' "effectively unbounded" for in-process
servers. The direct quotes win here; treat the env-var defaults as **[unknown]** until read
at source. `sdk.mjs` only shows the parsers (`MCP_TOOL_TIMEOUT: int({min:1})`), no default.

The spill-to-file fallback is load-bearing for v3: the file lands on the **Runner** (where
the CLI runs), and the documented recovery is the agent reading it back "in portions" — with
`Read` removed from the Runner, that path is dead. The hand server must cap and paginate
output itself (below the token cap, or with `maxResultSizeChars` raised) rather than rely on
the CLI's fallback.

### The natural v3 shape, given the above

The in-process `sdk` server is the only transport whose handler runs in the trusted Runner
process — the same place v2 runs `packages/document-tools` today [repo]. A hand server built
with `createSdkMcpServer` whose `bash`/`read`/`write`/`edit`/`glob`/`grep` handlers call the
VM's endpoint keeps the control-plane credential (`CreateMicrovmAuthToken`) and the endpoint
token in the Runner, lets the handler enforce output caps, timeouts and audit events
(doc §21), and needs no MCP server inside the VM. The `http` transport would instead put an
MCP server behind the VM endpoint with `headers: { 'X-aws-proxy-auth': …,
'X-aws-proxy-port': … }`; the token then expires in ≤60 min and must be re-registered via
`setMcpServers`, and the VM process would have to speak MCP — a reasonable alternative, but
strictly more moving parts.

## 3. The authenticated per-VM HTTPS endpoint

All from the AWS guide unless noted:
[Networking](https://docs.aws.amazon.com/lambda/latest/dg/microvms-networking.html),
[Running and using MicroVMs](https://docs.aws.amazon.com/lambda/latest/dg/microvms-launching.html),
[CreateMicrovmAuthToken](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_CreateMicrovmAuthToken.html),
[RunMicrovm](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_RunMicrovm.html),
[Lambda quotas](https://docs.aws.amazon.com/lambda/latest/dg/gettingstarted-limits.html)
(section "Lambda MicroVMs").

### Endpoint and protocols

- "Each Lambda MicroVM is reachable at a unique HTTPS endpoint URL, assigned when you call
  `run-microvm`"; "no load-balancing across MicroVMs from a single endpoint". Hostname form
  `abc123def456.lambda-microvm.<region>.on.aws`; v2 saw
  `<id>.lambda-microvm.us-west-2.on.aws` [repo memory].
- Supported inbound: "HTTP/1.1, HTTP/2, WebSockets, gRPC, Server-Sent Events (SSE)". TLS is
  always on client→endpoint; the app inside may serve plain HTTP. HTTP/2 negotiated by ALPN;
  `X-aws-proxy-force-h2: true` forces h2 to a plaintext app.
- Public by default ("Every MicroVM gets a unique public HTTPS endpoint URL"). Private path:
  interface VPC endpoint `com.amazonaws.<region>.lambda-microvm` with private DNS for
  `*.lambda-microvm.<region>.on.aws`; an endpoint policy evaluates the pseudo-action
  `lambda:ConnectMicrovm` with an anonymous principal. Ingress can be disabled with the
  `NO_INGRESS` managed connector.
- Port routing: `X-aws-proxy-port` header → WebSocket subprotocol `lambda-microvms.port.N`
  → default 8080. "The target port must be within the `allowedPorts` defined in the
  authentication token" (else 403). `X-aws-proxy-*` headers are stripped before forwarding.

### Auth tokens

- "All requests to a MicroVM endpoint require a JWE authentication token. There is no
  unauthenticated access option."
- `CreateMicrovmAuthToken`: `microvmIdentifier`, `allowedPorts` (≥1 of `{port}`,
  `{range:{startPort,endPort}}`, `{allPorts:{}}`), `expirationInMinutes` — "Maximum: 60
  minutes", schema minimum 1. Response `authToken` is a map; "Use the value at key
  `X-aws-proxy-auth`", value ≤8000 chars. Quota: 50 TPS (adjustable). No revocation API
  exists in the reference. Best practice: "Generate short-lived tokens (15–30 minutes)"
  ([best practices](https://docs.aws.amazon.com/lambda/latest/dg/microvms-best-practices.html)).
- WebSocket: subprotocols `["lambda-microvms", "lambda-microvms.authentication.<token>",
  "lambda-microvms.port.9000"]`; "Lambda removes MicroVM-specific subprotocols from the
  request before forwarding it to your application." No query-string form is documented.
- v2 today: `expirationInMinutes: 5`, `allowedPorts: [{ port: 8080 }]`, one mint per nudge,
  `fetch('https://<endpoint>/nudge', { headers: { 'x-aws-proxy-auth', 'x-aws-proxy-port' } })`
  ([`microvm-control-plane.ts`](../../apps/chat-api/src/features/conversation-vm/microvm-control-plane.ts),
  [`ensure-vm.ts`](../../apps/chat-api/src/features/conversation-vm/ensure-vm.ts));
  IAM: `lambda:CreateMicrovmAuthToken` on `microvm:*` plus `lambda:PassNetworkConnector` on
  the account egress connector and `arn:aws:lambda:<region>:aws:network-connector:*`
  ([`microvm.tf`](../../infra/terraform/microvm.tf)). `PassNetworkConnector` is not in the
  guide's IAM action table; it was learned by denial [repo memory].

### Streaming, sizes, timeouts

- Response streaming: SSE and WebSockets are listed protocols, so long-lived streamed
  responses are supported by design. Request streaming, chunked-request semantics: not
  mentioned. **[unknown]**
- Body size: no request or response byte cap is published. The only size-shaped limit is
  bandwidth, "scales linearly with its size": 1 MB/s (0.5 GB/0.25 vCPU) … 16 MB/s
  (8 GB/4 vCPU), applying to "both inbound requests and outbound responses".
- Per-request duration / idle-connection timeout at the proxy: not published. **[unknown]**
  This is the one number a long-running `bash` over a single HTTP request depends on; a
  WebSocket with the VM's own keepalive sidesteps it but is itself undocumented as to
  maximum lifetime.
- Concurrency (quotas page, not adjustable): concurrent connections per VM 8 (1 vCPU) / 16 /
  32 / 64 / 128 (16 vCPU); requests per second per VM 40 (4 vCPU/8 GB) … 160 (16 vCPU/32 GB).
  Error 429 "Rate limit exceeded (account-level or per-MicroVM)".
- Endpoint-originated errors: 400, 403 (bad/expired token or port), 429, 500, 502
  ("Application not responding, or auto-resume did not succeed").

### Suspend/resume interaction with in-flight work

- Idle policy: "The presence of traffic through the MicroVM's endpoint signals activity. If
  no traffic arrives for the configured idle duration, the MicroVM is treated as idle and
  suspended." `maxIdleDurationSeconds` minimum 60, maximum 28,800; `suspendedDurationSeconds`
  minimum 0; `autoResumeEnabled` required
  ([IdlePolicy](https://docs.aws.amazon.com/lambda/latest/microvm-api/API_IdlePolicy.html)).
  Whether an *open* WebSocket/SSE with no bytes flowing counts as traffic: **[unknown]**.
- Auto-resume: "Lambda holds the inbound request while the resume completes (including the
  `/resume` hook), then delivers it"; failure → 502. v2 measured ~4 s for a nudge on a
  suspended VM [repo memory].
- Explicit `SuspendMicrovm` (2 TPS) has no body and the docs never state what happens to a
  request or connection in flight; the `/suspend` hook is where the app should "close
  connections". v2's suspend hook drains its Turn and checkpoints through chat-api (#670)
  [repo]. **[unknown]** at the platform level.
- Lifecycle-hook timeouts (`runTimeoutInSeconds` etc.) are not on any guide or API page
  fetched; v2 measured the run hook's default killing the VM in ~3 s and set 60 s (#689),
  and the map records hooks "capped at 60 s" [repo memory]. Treat the cap as measured, not
  documented.
- `maximumDurationInSeconds` 1–28,800, not adjustable ("Maximum execution duration per
  MicroVM: 8 hours"). `runHookPayload`: guide says "max 16 KB", API schema says "Maximum
  length of 4096" — conflicting; v2 stays under 4096.
- Control-plane TPS (adjustable): RunMicrovm 5, ResumeMicrovm 5, SuspendMicrovm 2,
  TerminateMicrovm 10, GetMicrovm 100, CreateMicrovmAuthToken 50, CreateMicrovmShellAuthToken 5.

## 4. What the AWS Claude samples do

| Sample | Where the loop runs | How tool calls reach the VM | Output |
| :-- | :-- | :-- | :-- |
| [sample-lambda-microvm-claude-managed-agents](https://github.com/aws-samples/sample-lambda-microvm-claude-managed-agents) ([guide page](https://docs.aws.amazon.com/lambda/latest/dg/microvms-integrations-claude-managed-agents.html)) | Anthropic ("Anthropic hosts the agent loop and Claude model, while the Lambda MicroVM is where your tool calls run") | **Outbound from the VM**: a webhook triggers `RunMicrovm`; the in-VM Node `EnvironmentWorker` "claims the matching session from the Anthropic work queue, executes the agent's tool calls in `/workspace`, posts results back to Anthropic"; "The only inbound traffic is the webhook call; the rest of the workflow is pull-based." Tools: bash, read, write, edit, glob, grep. Per-session VM, idle policy `{120, 0, autoResume:false}`, self-`TerminateMicrovm`. | whole vs streamed: not stated |
| [anthropic-on-aws/claude-code-on-lambda-microvm](https://github.com/aws-samples/anthropic-on-aws/tree/main/claude-code-on-lambda-microvm) | inside the VM (Claude Code CLI + workspace) | user reaches a shell over "the MicroVM's native shell WebSocket" with a 5-minute shell credential (`CreateMicrovmShellAuthToken`); VS Code via an outbound dev-tunnel | interactive terminal, not tool RPC |

Neither sample drives per-tool-call requests *into* the VM through the JWE endpoint. The
Managed Agents sample is the closest analogue to §15 and it chooses the opposite direction
(VM pulls, no ingress) — which removes the token-lifetime, idle-timeout and body-cap
unknowns above at the price of a work-queue in the Runner. That is a design question for the
map, not for this ticket.

## 5. Implications for the spec (facts, not decisions)

1. Runner query options: `tools: []` (or an explicit built-in allowlist without
   Bash/file tools), `toolAliases: { Bash: 'mcp__hand__bash', Read: 'mcp__hand__read', … }`,
   `allowedTools: ['mcp__hand__*', …]`, `permissionMode: 'dontAsk'`, `strictMcpConfig: true`,
   `settingSources: []`, `alwaysLoad: true` on the hand server — the last so the hand tools
   are not hidden behind tool search on turn 1.
2. The hand server should be an in-process `createSdkMcpServer` in the Runner whose handlers
   talk to the VM; the VM needs an HTTP(S)/WebSocket server on the token's port, not an MCP
   server. Handlers own timeouts (server `timeout` ≥ the bash `timeout` they forward),
   output caps below the 25k-token spill, `isError` mapping, and audit events.
3. Token handling: mint per Session (≤60 min, refresh from the handler), port-scoped to the
   hand port; the VM holds nothing (doc §21). PrivateLink is available if the endpoint must
   leave the public internet.
4. Live stdout for the UI can stream VM→Runner (SSE/WebSocket are supported on the
   endpoint); the model still sees one whole result. Budget the per-VM bandwidth and the
   8–128 concurrent-connection quota when choosing one connection per tool call vs one
   multiplexed WebSocket per Session.
5. Because the built-in read-before-edit guard disappears with `tools: []`, decide whether
   the hand's `edit` verifies file mtime/hash itself.

## Open unknowns

- Endpoint per-request duration / idle timeout, request/response body caps, and whether an
  open connection with no bytes counts as idle-policy traffic. Needs a probe.
- Platform behaviour for an in-flight request or WebSocket when the VM suspends (idle or
  explicit); lifecycle-hook timeout ranges are measured (60 s) not documented.
- Whether the CLI applies the `BashOutput`→`TaskOutput` alias map to `disallowedTools`.
- Whether same-named MCP tools inherit any Read/Edit prompt guidance, and the actual quality
  delta of editing through MCP tools — prototype material.
- `MAX_MCP_OUTPUT_TOKENS` / `MCP_TOOL_TIMEOUT` defaults (conflicting doc fetches).
- `runHookPayload` cap (16 KB vs 4096).
- Whether the managed `ALL_INGRESS` connector can be port-restricted beyond the token's
  `allowedPorts` (only `NO_INGRESS`/`ALL_INGRESS`/`SHELL_INGRESS` names were seen).
