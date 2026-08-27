# Claude Code bridge with every built-in off and only user tools active

**Research date: 2026-08-27.** Resolves
[#608](https://github.com/X-GPT/mymemo-agent/issues/608) for the
[stage-2 map (#607)](https://github.com/X-GPT/mymemo-agent/issues/607).
Versions read: the chat-api pins `@ai-sdk/harness` **1.0.91**,
`@ai-sdk/harness-claude-code` **1.0.94**, `@ai-sdk/sandbox-vercel` **1.0.91**
([`apps/chat-api/package.json`](../../apps/chat-api/package.json),
[`bun.lock`](../../bun.lock)), read at the vercel/ai tag
[`@ai-sdk/harness-claude-code@1.0.94`](https://github.com/vercel/ai/tree/%40ai-sdk%2Fharness-claude-code%401.0.94)
("pin" below), and vercel/ai `main` at
[`805bbfc`](https://github.com/vercel/ai/commit/805bbfc2277211b1af621d23bbbfc8ee43adcc1c)
(2026-08-27, `@ai-sdk/harness-claude-code` 1.0.96; "main" below). The bridge
pins `@anthropic-ai/claude-agent-sdk` **0.3.213** and `@anthropic-ai/claude-code`
**2.1.213** at both
([bridge `package.json`, pin](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/package.json),
[main](https://github.com/vercel/ai/blob/805bbfc2277211b1af621d23bbbfc8ee43adcc1c/packages/harness-claude-code/src/bridge/package.json)).
Claude Agent SDK behaviour is taken from Anthropic's docs as published today;
where the doc describes a CLI version newer than 2.1.213, that is called out.

This note extends
[`ai-sdk-harness-agentcore-sandbox-feasibility-2026.md`](ai-sdk-harness-agentcore-sandbox-feasibility-2026.md)
(the "user tools", `activeTools`, `ENABLE_TOOL_SEARCH`, and `harness-tools`
relay sections) and
[`ai-sdk-harness-agent-api-2026.md`](ai-sdk-harness-agent-api-2026.md); it does
not repeat the `HarnessAgent` surface or the bridge-vs-host argument. It answers
the six #608 questions against source, line by line.

## Pin vs main: what changed

Between the pin and `main` the **bridge is byte-identical**
(`src/bridge/index.ts`, `src/bridge/tool-filtering.ts`,
`src/bridge/create-emit-stream-event.ts`, `src/bridge/json-schema-to-zod.ts`,
`src/bridge/package.json`), as are `@ai-sdk/harness`'s
`agent/internal/tool-filtering.ts`, `translate-stream-part.ts`, and
`v1/harness-v1-tool-filtering.ts`. `run-prompt.ts` gained only a `skills`
field. `claude-code-harness.ts` changed in three places, none of which touch
this ticket's mechanics: the `auth` option type narrowed to the string modes
(`'auto' | 'direct' | 'ai-gateway'`, dropping the deprecated object form chat-api
never used), skills are now written per turn instead of at start, and a WebSocket
listener-cleanup fix. `sandbox-vercel` changed only its version and changelog.
Every answer below therefore holds for both versions unless marked.

## 1. Allowlist mechanics

**What `HarnessAgent` computes.** With `activeTools` = user-tool names only,
`resolveHarnessAgentToolFiltering` keeps the named user tools and, because no
built-in name is in `activeTools`, produces
`builtinToolFiltering = { mode: 'allow', toolNames: [] }`
([`tool-filtering.ts#L35-L61`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/tool-filtering.ts#L35-L61)).
Names in `activeTools` must exist in the merged tool set or the constructor
throws `NoSuchToolError`
([L91-L104](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/tool-filtering.ts#L91-L104)).
Only the active user tools are projected over the wire as tool specs; built-ins
are never re-declared
([`harness-agent.ts#L735-L760`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/harness-agent.ts#L735-L760)).
The adapter forwards `builtinToolFiltering` and `permissionMode` unchanged in
the `start` message
([`claude-code-harness.ts#L1702-L1732`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L1702-L1732)).

**What reaches the Claude Agent SDK.** In the bridge:

- `tools: []` — `resolveNativeTools` maps the allow-list's (empty) names to
  native names and the bridge passes the array whenever it is defined
  ([`bridge/tool-filtering.ts#L40-L45`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/tool-filtering.ts#L40-L45),
  [`bridge/index.ts#L323-L346`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L323-L346)).
- `disallowedTools: [<27 native names>]` — every name in the bridge's
  `PUBLIC_TO_NATIVE` table that is not allowed: `Read`, `Write`, `Edit`, `Bash`,
  `Glob`, `Grep`, `WebSearch`, `WebFetch`, `NotebookEdit`, `TodoWrite`, `Agent`,
  `TaskCreate`, `TaskGet`, `TaskUpdate`, `TaskList`, `TaskStop`, `TaskOutput`,
  `Monitor`, `ListMcpResources`, `ReadMcpResource`, `ExitPlanMode`,
  `EnterWorktree`, `ExitWorktree`, `AskUserQuestion`, `Skill`, `ToolSearch`
  ([`bridge/tool-filtering.ts#L5-L58`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/tool-filtering.ts#L5-L58),
  [`bridge/index.ts#L347-L349`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L347-L349)).
  Anthropic documents a bare name in `disallowedTools` as removing the tool
  from Claude's context
  ([TypeScript SDK reference, `disallowedTools`](https://code.claude.com/docs/en/agent-sdk/typescript#options)).
- `allowedTools` — **never set** by the bridge (grep of `bridge/index.ts`); the
  SDK documents it as auto-approval only, not a restriction.
- `permissionMode: 'default'`, `allowDangerouslySkipPermissions: false`, a
  `settings.permissions.ask` rule `"<Tool>(*)"` for each inactive native tool
  plus `sandbox.autoAllowBashIfSandboxed: false`, and a `canUseTool` callback
  ([`bridge/index.ts#L139-L238`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L139-L238)).
- `mcpServers: { 'harness-tools': { type: 'sdk', instance } }` (see §2), plus
  the `systemPrompt` preset `claude_code` with `instructions` appended,
  `includePartialMessages: true`, `thinking`, `effort`, a `PostCompact` hook,
  `cwd: workdir`, and `env: { ...process.env, ...start.env }` when `start.env`
  is defined
  ([`bridge/index.ts#L339-L390`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L339-L390)).

**Does `permissionMode: 'allow-all'` matter once the native set is empty?**
Yes, in a way the feasibility note did not spell out. The bridge only maps
`allow-all` to the SDK's `bypassPermissions` when **no** native tool is
inactive
([`bridge/index.ts#L154-L159`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L154-L159)).
With 27 inactive names it takes the other branch: SDK `permissionMode:
'default'` with ask rules and `canUseTool`. Inside `canUseTool`, any
`mcp__harness-tools__*` call is allowed immediately (L171-L173); any other
tool that is not inactive and, under `allow-all`, needs no approval is also
allowed (L174-L182); and an inactive native name would be turned into a
`providerExecuted: true` `tool-call` + `tool-approval-request` and block on
the host's decision (L184-L209). `allow-all` therefore still decides one thing:
whether a native tool that is **not** in the 27-name table (a future CLI tool)
would be auto-allowed by `canUseTool` (L176-L182, `nativeToolRequiresApproval`
returns `false` under `allow-all`). That gap is closed by `tools: []`, which
removes every built-in the CLI knows about before `canUseTool` is consulted
(Anthropic's `tools` option is the enabled set; the CLI-native `ToolSearch`
issue below is the one documented case where a CLI tool showed up despite the
adapter not knowing it, and that arose with `tools` unset). The remaining
safety net is host-side: a `providerExecuted: true` approval request for a
tool outside the allow-list is auto-denied by `HarnessAgent` with the
filtering reason, before any approval reaches chat-api
([`run-prompt.ts#L691-L721`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L691-L721),
[`harness-v1-tool-filtering.ts#L11-L25`](https://github.com/vercel/ai/blob/805bbfc2277211b1af621d23bbbfc8ee43adcc1c/packages/harness/src/v1/harness-v1-tool-filtering.ts#L11-L25)).
Keep `allow-all` (the map's decision) — it changes nothing for user tools, and
a stricter mode would only add ask rules for tools that are already absent.

**Catalog mismatch to know about.** The adapter's `builtinTools` catalog (the
names `HarnessAgent` validates `activeTools` against and the names it can
emit as typed `providerExecuted: true` parts) has 50 entries at both pin and
main — the 27 above plus `ListMcpResourcesTool`, `ReadMcpResourceTool`,
`ReadMcpResourceDirTool`, `RefreshMcpTools`, `EnterPlanMode`, `Artifact`,
`CronCreate`, `CronDelete`, `CronList`, `DesignSync`, `LSP`, `PowerShell`,
`PushNotification`, `RemoteTrigger`, `ReportFindings`, `ScheduleWakeup`,
`SendMessage`, `SendUserFile`, `ShareOnboardingGuide`, `WaitForMcpServers`,
`Workflow`
([`claude-code-harness.ts#L176-L776`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L176-L776)).
The bridge's `disallowedTools` list covers only the 27; the other 23 are
excluded solely by `tools: []`. Whether the CLI honours `tools: []` for every
one of those (some are claude.ai-only surfaces) is **unverified** from source;
the live invariant test in §7 is what should settle it.

**`ToolSearch` and `ENABLE_TOOL_SEARCH`.** vercel/ai
[#16694](https://github.com/vercel/ai/issues/16694) reported that the CLI
defers `harness-tools` MCP definitions and the model calls the CLI-native
`ToolSearch` to hydrate them, which surfaced as a `NoSuchToolError` /
`tool-input-error` because the adapter did not know the tool. The catalog
half of the fix shipped in `@ai-sdk/harness-claude-code` **1.0.32**
(changelog entry `c93c87e`, "add ToolSearch to claude code builtin tools",
[CHANGELOG](https://github.com/vercel/ai/blob/805bbfc2277211b1af621d23bbbfc8ee43adcc1c/packages/harness-claude-code/CHANGELOG.md));
the contributor's PR [#16696](https://github.com/vercel/ai/pull/16696), which
also proposed degrading unknown provider-executed calls to `dynamic`, was
closed unmerged, and `validateToolCall` still routes through `parseToolCall`
with the merged tool set, so an unknown provider-executed name is still an
invalid call
([`run-prompt.ts#L1233-L1264`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L1233-L1264)).
At the pin, `ToolSearch` is in the catalog
([L504-L511](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L504-L511)),
in the bridge's `PUBLIC_TO_NATIVE` and `NATIVE_TOOL_KINDS` tables, and so is
**both** in `disallowedTools` and outside `tools: []` on MyMemo's
configuration. Three further facts from Anthropic's
[tool search doc](https://code.claude.com/docs/en/agent-sdk/tool-search#configure-tool-search):
tool search is on by default and applies to custom SDK MCP servers; the SDK
**disables it by default when `ANTHROPIC_BASE_URL` points to a
non-first-party host**, which is chat-api's OpenRouter setup
([`harness-chat-agent.ts#L21`](../../apps/chat-api/src/features/ai-chat/harness-chat-agent.ts#L21));
and `ENABLE_TOOL_SEARCH=false` forces all definitions to load up front. So on
the current OpenRouter route the workaround is redundant with the SDK
default, and with `ToolSearch` itself disabled the failure mode changes from
a spurious error to the model being unable to hydrate a deferred tool at all.
`ENABLE_TOOL_SEARCH=false` is therefore still worth setting **explicitly**: it
is the only setting that makes the "no deferred tools" state independent of
the base URL (a later Anthropic-direct or AI Gateway route would re-enable
deferral). Note the doc also says `false` cannot be overridden by the SDK's
own unsupported-model fallback (which loads upfront anyway) and that the
CLI's behaviour on this axis changed at v2.1.221/2.1.227 — later than the
bridge's 2.1.213 pin; the pin's exact default on a proxy base URL is
**unverified** beyond the doc statement.

**How to set it.** `createVercelSandbox` has no `env` option
(`vercel-sandbox.ts` reads only `VERCEL_OIDC_TOKEN` from the host env), and the
sandbox `spawn` env carries only bridge bootstrap variables
(`BRIDGE_CHANNEL_TOKEN`, `BRIDGE_WS_PORT`, optional `HOME`,
`BRIDGE_REPLAY_FROM_DISK`;
[`claude-code-harness.ts#L1057-L1063`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L1057-L1063)).
The route is `createClaudeCode({ env: { ENABLE_TOOL_SEARCH: 'false' } })`:
`settings.env` is spread into the Claude environment after the resolved auth
variables
([L866-L879](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L866-L879)),
sent as `start.env` on every turn
([L1719](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L1719)),
and merged over the bridge's `process.env` into the SDK `env` option
([`bridge/index.ts#L344`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L344)).
That same `env` map is where the brokered credential placeholders travel (§6).

## 2. User-tool relay

**Exposure to Claude.** When `start.tools` is non-empty the bridge builds one
in-process `McpServer` named `harness-tools` and registers each user tool with
`server.tool(name, description ?? '', zodShape, handler)`; the Zod shape is
derived from the tool's JSON Schema by `jsonSchemaToZodShape` (supports
`type`, `properties`/`required`, `items`, `enum`, `const`, `oneOf`/`anyOf`,
`nullable`, `description`; anything else degrades to `z.any()`)
([`bridge/index.ts#L266-L307`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L266-L307),
[`json-schema-to-zod.ts`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/json-schema-to-zod.ts)).
Claude sees the tool as `mcp__harness-tools__<name>`. `createClaudeCode`
rejects an adapter `mcpServers` entry named `harness-tools`
([`claude-code-harness.ts#L810-L817`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L810-L817)).
The JSON Schema comes from `asSchema(tool.inputSchema).jsonSchema` on the
host; a tool whose schema cannot be converted is forwarded by name with no
schema ([`harness-agent.ts#L742-L758`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/harness-agent.ts#L742-L758)).

**Call path.** The MCP handler mints a `randomUUID()` tool-call id, emits
`tool-call { toolName: <short name>, input: JSON string, providerExecuted:
false }`, and awaits `turn.requestToolResult(toolCallId)`
([`bridge/index.ts#L278-L287`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L278-L287)).
On the host, `run-prompt` validates the call with `parseToolCall` against the
merged tool set, then — if the name is in `activeTools` and the tool has an
`execute` — runs `maybeExecuteHostTool`; a name outside `activeTools` is
answered with `{ type: 'execution-denied', reason }` without executing
([`run-prompt.ts#L882-L897`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L882-L897),
[L992-L1055](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L992-L1055)).

**What `execute()` receives.** The input is the bridge's JSON string parsed
back to a value (raw string if unparsable), and the options object is
`{ toolCallId, messages: [], abortSignal, context: undefined,
experimental_sandbox }`
([`run-prompt.ts#L1145-L1194`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L1145-L1194)).
Specifically:

- `toolCallId` is the bridge's synthetic UUID, not Claude's `toolu_…` id; the
  native id never leaves the bridge.
- `messages` is always empty — the harness session owns history, so a tool
  cannot see the conversation.
- `abortSignal` is the turn's signal (chat-api passes `c.req.raw.signal`).
- `experimental_sandbox` is the **restricted** view of the Vercel network
  session (`sandboxSession.restricted()`), i.e. file/command access to the
  Harness sandbox, not the E2B Workspace
  ([`harness-agent-session.ts#L198-L210`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/harness-agent-session.ts#L198-L210),
  [`get-restricted-sandbox-session.ts`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/utils/get-restricted-sandbox-session.ts)).
  The map's "discard it" decision stands; the regression test from the
  feasibility note (a session whose methods throw if touched) still applies.
- Generator `execute` functions work: every `yield` before the last is
  surfaced to the consumer as a `preliminary` `tool-result` part and never
  reaches Claude (L1166-L1175).

**What it must return.** Any JSON-serialisable value — **not** an MCP
`CallToolResult`. The host submits `output` as-is; the bridge wraps it as
`{ content: [{ type: 'text', text: JSON.stringify(output ?? null) }], isError }`
([`bridge/index.ts#L295-L298`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L295-L298)).
Returning an MCP envelope would give Claude a JSON string of an envelope inside
a text block. A plain string output is fine (it arrives as a JSON-quoted
string); an object arrives as its JSON. The host also strips the session work
directory from the displayed result (`stripWorkDir`), which is display-only —
E2B paths are unaffected
([`run-prompt.ts#L663-L669`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L663-L669)).

**Errors.** A thrown `execute` is caught on the host and submitted as
`{ output: { error: String(err) }, isError: true }`
([`run-prompt.ts#L1207-L1216`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/run-prompt.ts#L1207-L1216));
Claude receives an MCP result with `isError: true` whose text is
`{"error":"…"}`, and the turn continues (Claude can react). There is no
retry or repair hook on this path. Bounded, model-readable failures (the
existing handlers' `isError` envelopes) should therefore be returned as
ordinary values with an explicit error field, and only unexpected faults
thrown; both are model-visible.

**No deferred-tool hydration inside the relay.** The relay registers all
tools on the `McpServer` before `query()` starts (L272-L301); nothing in the
bridge defers or lazily loads definitions. Whether the CLI then *defers* them
toward `ToolSearch` is the SDK-side decision covered in §1.

## 3. Stream parts

For a user tool, the consumer sees exactly one `tool-input-available` and one
`tool-output-available` (or `tool-output-error`) per call:

- Bridge `tool-call { providerExecuted: false, toolName: <short name> }` →
  `validateToolCall` → AI SDK `tool-call` part with the parsed input, typed
  against the user tool (not `dynamic`) →
  `toUIMessageChunk` `tool-input-available { toolCallId, toolName, input,
  providerExecuted: false }`
  ([`to-ui-message-chunk.ts#L209-L249`](https://github.com/vercel/ai/blob/805bbfc2277211b1af621d23bbbfc8ee43adcc1c/packages/ai/src/ui-message-stream/to-ui-message-chunk.ts#L209-L249)).
  The name is the **short** `HarnessAgent` key (`SearchDocuments`), never
  `mcp__harness-tools__SearchDocuments`; the MCP-qualified name exists only
  between the bridge and the CLI.
- Bridge `tool-result { isError }` echoed after the host result →
  `translateStreamPart`: because the raw call was not provider-executed, both
  success and `isError` become a `tool-result` part (`tool-output-available`)
  whose `output` is the host's value (`{ error }` on failure) — **not** a
  `tool-error`. `tool-error` is only produced for provider-executed errors, so
  that `toUIMessageChunk`'s generic `onError` text is never substituted for a
  host tool's output
  ([`translate-stream-part.ts#L116-L158`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/translate-stream-part.ts#L116-L158),
  [`to-ui-message-chunk.ts#L274-L316`](https://github.com/vercel/ai/blob/805bbfc2277211b1af621d23bbbfc8ee43adcc1c/packages/ai/src/ui-message-stream/to-ui-message-chunk.ts#L274-L316)).
  Practical consequence: chat-api's `onError` (the "An error occurred."
  scrubber) is not on the user-tool error path; the tool's error string goes
  to the browser verbatim, so bounding and redaction belong in the tool
  wrapper.
- The duplicate that Claude itself reports — the `tool_use` block named
  `mcp__harness-tools__*` on the assistant message and the matching
  `tool_result` on the next user message — is suppressed by the bridge and
  only used to open/close the step
  ([`create-emit-stream-event.ts#L217-L223`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/create-emit-stream-event.ts#L217-L223),
  [L259-L263](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/create-emit-stream-event.ts#L259-L263)).
  Ordering: the host-side `tool-input-available` is emitted when the bridge's
  MCP handler fires, which is after the assistant message containing the
  `tool_use` block has been processed, so text emitted before the call
  precedes it.

**Can a built-in still surface as `providerExecuted: true`?** Three sources
remain, none of them a native tool executing:

1. A CLI tool that slips past `tools: []` / `disallowedTools`. The bridge
   would emit `providerExecuted: true` on the `tool_use` block (typed if in
   the 50-name catalog, `dynamic: true` if it starts with `mcp__`, invalid
   otherwise)
   ([`create-emit-stream-event.ts#L224-L241`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/create-emit-stream-event.ts#L224-L241)),
   and — if `canUseTool` was consulted for an inactive name — a
   `tool-approval-request` that `HarnessAgent` auto-denies (§1). Seeing this
   at all is the invariant violation the map already names.
2. Synthetic `dynamic: true, providerExecuted: true` pairs named
   `fileChange` and `compaction`, projected by `@ai-sdk/harness` for
   `file-change` and `compaction` events
   ([`translate-stream-part.ts#L160-L244`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/agent/internal/translate-stream-part.ts#L160-L244)).
   The Claude bridge never emits `file-change`; `compaction` **can** fire on
   a long Conversation (the bridge latches `compact_boundary` + `PostCompact`).
   The built-in invariant check must exempt these two names, or key on
   `nativeName` being present.
3. Claude's `StructuredOutput` pseudo-tool for JSON output — suppressed by the
   bridge, and not used by chat-api.

## 4. Transcript

Yes: user-tool outputs are persisted in the sandbox transcript. The bridge
passes `cwd: workdir` and never sets `persistSession`
([`bridge/index.ts#L339-L389`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L339-L389)),
whose SDK default is `true`
([TypeScript SDK reference, `persistSession`](https://code.claude.com/docs/en/agent-sdk/typescript#options)).
Anthropic states the session "contains your prompt, every tool call the agent
made, every tool result, and every response" and is written to
`~/.claude/projects/<encoded-cwd>/*.jsonl`
([Sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). An MCP tool
result is a `tool_result` block on a user message like any other, and the
bridge relies on exactly this file surviving in the snapshot — the
`{ continue: true }` resume rehydrates the thread from the workdir
([`claude-code-bootstrap.ts#L10-L15`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-bootstrap.ts#L10-L15),
[`bridge/index.ts#L380-L384`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L380-L384)).
What persists is the bridge's text block: `JSON.stringify(output)` of
whatever the host returned, plus `isError`. Document content loaded by
`LoadDocuments`, E2B file contents from `Read`, and Bash stdout therefore
land in the Vercel Sandbox snapshot (per Conversation, `keepLastSnapshots:
{ count: 1 }` in stage 1). Turning persistence off is not an option without
forking the bridge, and would also break resume. Bounding output size at the
tool wrapper is the lever, as the map's "tool-part bounding" item anticipates.
(The vercel/ai adapter's own hard cap, if any, on `tool-result` payloads was
not found in source — **unverified**; the bridge emits `output ?? null`
unbounded.)

## 5. Thinking

`thinking` can be re-enabled independently of tools. `createClaudeCode`
defaults to `{ type: 'adaptive', display: 'summarized' }`; the value is sent
verbatim on every `start` and passed straight to the SDK's `thinking` option
([`claude-code-harness.ts#L818-L821`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L818-L821),
[`bridge/index.ts#L351`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/index.ts#L351);
schema at
[`claude-code-bridge-protocol.ts#L19-L31`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-bridge-protocol.ts#L19-L31)).
The adapter's type is `{ type: 'adaptive' | 'enabled', display?: 'summarized'
| 'omitted' } | { type: 'disabled' }` — it does **not** expose the SDK's
`budgetTokens` for `enabled`
([`claude-code-thinking.ts`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-thinking.ts)
vs [`ThinkingConfig`](https://code.claude.com/docs/en/agent-sdk/typescript#thinkingconfig)).
`effort` (`low`…`max`) is the companion knob for adaptive thinking.

What the stream shows: with `includePartialMessages: true` the bridge turns
`content_block_start/delta/stop` for `thinking` blocks into
`reasoning-start` / `reasoning-delta` / `reasoning-end`
([`create-emit-stream-event.ts#L374-L429`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/bridge/create-emit-stream-event.ts#L374-L429)),
which `@ai-sdk/harness` forwards as AI SDK `reasoning-*` parts and the UI
stream renders as `reasoning-start` / `reasoning-delta` / `reasoning-end`
chunks (a `reasoning` part on the `UIMessage`). With `display: 'omitted'`,
or on Opus 4.7+ where Anthropic says the API default is `omitted`, the
thinking blocks arrive empty and the UI shows an empty reasoning part; set
`display: 'summarized'` to get text. Through OpenRouter, whether `display` and
thinking blocks are forwarded is **unverified** (the Anthropic doc only
documents Bedrock and Google Cloud's Agent Platform as dropping `display`);
this is a one-line spec decision plus a live check, as the map expects.
Thinking content is model output, not tool output, so it is unaffected by the
allow-list; the interleaving is reasoning → `tool-input-available` →
`tool-output-available` → reasoning/text within one step.

## 6. Credential reach

**What is in the sandbox.** With `auth: 'direct'`, chat-api's process env
supplies `ANTHROPIC_BASE_URL` (OpenRouter) and `ANTHROPIC_AUTH_TOKEN`, with
`ANTHROPIC_API_KEY` set to empty
([`harness-chat-agent.ts#L20-L26`](../../apps/chat-api/src/features/ai-chat/harness-chat-agent.ts#L20-L26)).
Because the Vercel network session implements `addRequestTransformations`,
the adapter replaces each of `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`,
`ANTHROPIC_AUTH_TOKEN` that is present with a random placeholder
`aisdkhc_<43 base64url chars>` and registers a firewall rule that swaps the
placeholder for the real bearer only on requests to the base URL's host and
path prefix with that exact header value
([`claude-code-harness.ts#L881-L916`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-harness.ts#L881-L916),
[`claude-code-auth.ts#L14-L60`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness-claude-code/src/claude-code-auth.ts#L14-L60),
[`sandbox-credential-brokering.ts#L4-L12`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/utils/sandbox-credential-brokering.ts#L4-L12),
[`credential-forwarding.ts#L33-L58`](https://github.com/vercel/ai/blob/%40ai-sdk%2Fharness-claude-code%401.0.94/packages/harness/src/utils/credential-forwarding.ts#L33-L58)).
The placeholder is reused across resumes (persisted in lifecycle state).
Every other variable in `settings.env` and the bridge's `process.env` —
including `ANTHROPIC_BASE_URL`, `BRIDGE_CHANNEL_TOKEN`, and
`ENABLE_TOOL_SEARCH` — is in the Claude subprocess environment in the clear.
Nothing else from chat-api (E2B, KB, Postgres, Vercel token) is ever copied
into the sandbox; user tools execute in chat-api.

**Model-directed routes, with built-ins off.** The model can act only through
`mcp__harness-tools__*`, which run on the host against E2B, so no
model-issued call reads the Harness sandbox's environment or filesystem: no
`Bash`, `Read`, `Glob`, `Grep`, `WebFetch`, `Agent`, `Skill`, `Monitor`, or
`ReadMcpResource`. A user tool that ignores `experimental_sandbox` cannot
reach it either. The bridge's own `mcpServers` is empty on this design, so
there is no other MCP surface. Remaining routes, none of them tool calls:

- **Prompt-side leakage of environment.** The `claude_code` system-prompt
  preset and the CLI's context-gathering (e.g. `CLAUDE.md`, git status,
  `cwd`) could in principle put sandbox facts in the model's context. Whether
  the CLI includes any environment variable value in the preset prompt at
  2.1.213 is **unverified** from source (the CLI is a binary); the placeholder
  is not a file, and the workdir is created empty by the adapter, so the
  plausible surfaces are the `cwd` path and whatever the `init` message
  reports. Worth one live check: ask the model for its environment and
  confirm the answer contains no `aisdkhc_` string.
- **Value of the placeholder if it did leak.** It is only honoured by the
  Vercel firewall for requests originating **inside that sandbox** to the
  brokered host with the exact header; outside the sandbox it is an opaque
  random string. A leaked placeholder therefore gives an attacker nothing
  unless they can also make requests from within the sandbox — which, with
  no execution tool, they cannot. The sandbox's own outbound network policy
  is what bounds what the CLI process can reach; §"Not yet specified" in the
  map (Gateway, per-Conversation token) is about limiting blast radius of the
  **real** credential held in chat-api, not about the placeholder.
- **Transcript and snapshot.** The transcript (§4) records model messages and
  tool results, not the environment; but anything the model is told or a
  tool returns is in it. Anyone with Vercel project access can read the
  snapshot. That is an operator-trust boundary, not a model route.
- **Bridge and CLI as trusted code.** As the feasibility note already says,
  the adapter, bridge, Agent SDK, and CLI run with the placeholder in their
  environment; a compromised dependency could exfiltrate it (and use it from
  inside the sandbox). Supply-chain trust in `@ai-sdk/harness-claude-code`'s
  bridge lockfile is the honest statement of that risk.

Net: with every built-in off, "no Bash, no reach" is correct for
model-directed access, with two caveats to write into the spec — the
`compaction`/`fileChange` exemption in the invariant, and the live
"no `aisdkhc_` in model-visible context" check.

## 7. Implications for MyMemo stage 2

- **Configuration.** `new HarnessAgent({ harness, tools, activeTools:
  Object.keys(tools), permissionMode: 'allow-all' })` with
  `createClaudeCode({ auth: 'direct', model, thinking, env: {
  ENABLE_TOOL_SEARCH: 'false' } })` and no adapter `mcpServers`. Keep the
  `env` line even though OpenRouter already suppresses tool search; it is the
  route-independent guarantee. No sandbox-provider change is needed.
- **Tool wrapper contract.** `execute(input, { toolCallId, abortSignal })` →
  return a JSON value (adapt the existing MCP `CallToolResult` envelopes to
  `{ text }`/structured output; never return the envelope); throw only for
  faults; discard `experimental_sandbox`; pass `abortSignal` to E2B calls.
  `messages` is empty, so any per-Conversation context (scope, sandbox id)
  must be closed over at construction, as the feasibility note already
  concludes.
- **Names.** `HarnessAgent` keys are the short names (`Bash`, `Read`, …);
  they do not collide with the adapter's lowercase built-in keys (`bash`,
  `read`), and the UI stream carries the short name. The disallowed native
  `Bash` and the user tool `Bash` are different identifiers on both sides of
  the bridge (`Bash` vs `mcp__harness-tools__Bash`).
- **Invariant regression test.** Assert on the AI SDK stream that every
  `tool-call` has `providerExecuted !== true`, exempting `toolName in
  {'compaction', 'fileChange'}` with `dynamic: true`; treat any other
  `providerExecuted: true`, any `tool-approval-request`, and any `invalid`
  tool call as a failed turn. Also assert the bridge `start` payload (via the
  fake harness) carries `builtinToolFiltering: { mode: 'allow', toolNames: [] }`.
  A live check should confirm that none of the 23 catalog-only tools (e.g.
  `Artifact`, `SendUserFile`) is advertised in the SDK `init` message's
  `tools` list.
- **Errors and bounding.** Host-tool failures reach the browser as
  `tool-output-available` with the wrapper's output, bypassing chat-api's
  `onError` scrubber; and every output is persisted in the sandbox
  transcript. Bound and redact in the wrapper, once, for both audiences.
- **Thinking.** Re-enabling is `thinking: { type: 'adaptive', display:
  'summarized' }` (or the adapter default) and yields `reasoning-*` parts; it
  needs one live check through OpenRouter. No interaction with tools.
- **Credential scoping.** The placeholder design already keeps the real
  bearer out of the sandbox; with built-ins off there is no model route to
  the placeholder. The remaining reasons to tighten (Gateway, short-lived
  token) are blast radius of the real credential in chat-api and operator
  access to snapshots — decide on those grounds, not on model reach.
