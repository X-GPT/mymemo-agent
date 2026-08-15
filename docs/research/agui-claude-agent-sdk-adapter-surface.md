# What `@ag-ui/claude-agent-sdk`'s `ClaudeAgentAdapter` Actually Exposes

**Verified on: 2026-08-14.** Every claim below is traced to a primary source: the adapter's
own TypeScript source on `ag-ui-protocol/ag-ui@main` (repo HEAD `0c0b88a`; `adapter.ts` last
touched by `4bd4f95`, 2026-05-22), the published npm metadata for `@ag-ui/claude-agent-sdk`,
the `@ag-ui/client` `AbstractAgent` source (`7183701`, 2026-08-07), and the
`@anthropic-ai/claude-agent-sdk@0.3.218` `sdk.d.ts` typings vendored in this repo's
`node_modules`. Where a claim rests on RxJS runtime semantics rather than on a line of
adapter code, it is marked and backed by a runnable experiment described in §4.3. Where
something could **not** be established from a primary source, it says so.

Research question (issue #463): can the adapter be **depended on as a released package and
wrapped** — never patched internally — while the AgentCore canary runtime retains everything
ADRs 0004/0005/0006/0014/0017/0023 say it must own?

---

## Executive summary

**Verdict: the wrap is mechanically possible for options, cwd, SessionStore and tools, and
partially possible for event interception — but the interception seam is an *ordering* seam,
not a *backpressure* seam, and the package is materially behind both its Python sibling and
our pinned SDK.**

1. **Options, cwd, SessionStore, MCP tools: fully suppliable.** `ClaudeAgentAdapterConfig` is
   literally `AgentConfig & Options & {…}` (`src/types.ts:55`), and `buildOptions()` spreads
   the whole config into what it hands `query()` (`src/adapter.ts:285-289`). Every ADR-0006
   key — `tools: []`, `settingSources: []`, `permissionMode: "dontAsk"`, `allowedTools`,
   `systemPrompt`, `env`, `pathToClaudeCodeExecutable`, `cwd`, `sessionStore`, `mcpServers` —
   is an `Options` key and passes through. Three mutations are applied on top and must be
   suppressed by construction (§2.2).

2. **There is no hook between "AG-UI event formed" and "event delivered".** Inside the
   adapter, every event is a direct `subscriber.next(…)` call at ~40 sites; the two methods
   that own them (`translateStream`, `streamMessages`) are `private`; there is no `onEvent`,
   no `emit()` override point, no protected template method. The only seam is **outside**:
   `adapter.run(input)` is public and returns a cold `Observable<BaseEvent>`, so the wrapper
   owns the whole operator chain. `concatMap(async e => { await commitToPg(e); await
   publish(e); return e; })` gives **strict ordering** and commit-before-publish. It does
   **not** give backpressure: `subscriber.next()` returns immediately, so the adapter keeps
   draining the Claude SDK stream while our commits queue behind it (§4).

3. **The package is thinly maintained and version-drifted.** Three published versions ever
   (`0.0.2`, `0.0.3`, one canary); latest `0.0.3` published **2026-05-26**; 13 commits ever
   under `integrations/claude-agent-sdk/typescript`, last functional change 2026-05-22. The
   Python sibling is at `0.1.5+` with 49 commits and correctness fixes landing through July
   2026 that **have no TypeScript counterpart** (§6). The peer range is
   `"@anthropic-ai/claude-agent-sdk": "^0.2.58"` — **our pinned `0.3.218` is outside it**.

4. **RxJS is a real new dependency, and it does not come alone.** `rxjs@7.8.1` (~4.5 MB
   unpacked, 2277 files) is the adapter's only runtime dep, but `@ag-ui/client` is a *required*
   peer (the adapter imports `AbstractAgent`, `EventType`, `randomUUID` from it), and it drags
   `@ag-ui/core`, `@ag-ui/encoder`, `@ag-ui/proto` (→ `@bufbuild/protobuf`), `uuid`, `zod`,
   `fast-json-patch`, `untruncate-json`, `compare-versions`. We currently have `@ag-ui/core`
   only, and **zero rxjs** anywhere in the tree.

5. **Behavioural gaps against our ADRs that a wrapper must re-add anyway:** no `RUN_ERROR` on
   an `is_error` result (§6.1); `mirror_error` is downgraded to a `CUSTOM` event instead of
   failing the turn, contradicting ADR-0005's fail-fast (§5.3); `PresentUI` would be projected
   as an ordinary tool call, contradicting ADR-0017's display-only exclusion (§3.2);
   `TOOL_CALL_RESULT` carries full tool-result text onto the wire (§3.3); unsubscribing does
   **not** stop the query, because the Observable returns no teardown (§4.4).

---

## 1. What the package is, exactly

| Fact | Value | Source |
|---|---|---|
| npm name | `@ag-ui/claude-agent-sdk` | `integrations/claude-agent-sdk/typescript/package.json:2` |
| Latest version | `0.0.3`, published 2026-05-26T17:09:32Z | npm registry `time` map |
| All versions | `0.0.2-canary.1777061096.0` (2026-04-24), `0.0.2` (2026-04-24), `0.0.3` (2026-05-26) | npm registry |
| License | MIT | `package.json:3` |
| Runtime deps | `rxjs: 7.8.1` (only) | `package.json:32-34` |
| Peer deps | `@ag-ui/client >=0.0.42`, `@ag-ui/core >=0.0.42`, `@anthropic-ai/claude-agent-sdk ^0.2.58`, `@anthropic-ai/sdk >=0.50.0`, `zod >=3.0.0` | `package.json:35-41` |
| Public exports | `ClaudeAgentAdapter`, `ClaudeAgentAdapterConfig`, `ProcessedEvent`, `ALLOWED_FORWARDED_PROPS`, `STATE_MANAGEMENT_TOOL_NAME`, `AG_UI_MCP_SERVER_NAME`, `extractToolNames` | `src/index.ts:16-23` |
| Source size | `adapter.ts` 974 lines, `utils.ts` 436, `handlers.ts` 137, `types.ts` 86, `config.ts` 46 | fetched from `raw.githubusercontent.com/…/main/…` |

**Not listed as an AG-UI integration in the docs.** `docs/integrations.mdx` on `main` lists
LangGraph, Microsoft Agent Framework, Google ADK, AWS Strands, Mastra, Pydantic AI, Agno,
LlamaIndex, CrewAI, AG2, and **"Claude Managed Agents"** — the Claude *Agent SDK* adapter is
absent. `https://docs.ag-ui.com/integrations/claude-agent-sdk` returns **404**. The package
exists on npm and in the monorepo but has no first-party documentation page.

*(Sidebar, relevant to map #462 but out of scope here: the same page lists Amazon Bedrock
AgentCore under "Infrastructure / Deployment" with "native protocol support" for AG-UI,
pointing at `docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-agui.html`. Not
investigated for this ticket.)*

### 1.1 The public class surface

From `src/adapter.ts`:

| Member | Visibility | Line |
|---|---|---|
| `headers?: Record<string,string>` | public field | 72 |
| `constructor(config: ClaudeAgentAdapterConfig = {})` | public | 81 |
| `clearSession(threadId)` | public | 113 |
| `clone()` | public | 117 |
| `interrupt()` | public, `await`s `q.interrupt()` on every active query | 126 |
| `run(input): Observable<BaseEvent>` | public | 132 |
| `buildOptions(input): Options` | **public** | 268 |
| `translateStream(...)` | **private** | 192 |
| `streamMessages(...)` | **private** | 392 |
| `evictSessions()` | private | 86 |

The two methods that actually form and push events are `private`. `buildOptions` being public
is the one deliberate composition seam the class offers.

---

## 2. Can a caller supply the `query()` options? — **Yes, with three mandatory guards**

### 2.1 The mechanism

`ClaudeAgentAdapterConfig = AgentConfig & Options & { maxSessions?, sessionTtlMs?,
queryTimeoutMs? }` (`src/types.ts:55-62`). `buildOptions()` starts from
`{ includePartialMessages: true }`, destructures out the six AG-UI-only keys (`agentId`,
`description`, `threadId`, `initialMessages`, `initialState`, `debug`), and copies **every
remaining config key whose value is not nullish** into the options object
(`src/adapter.ts:270-289`):

```ts
for (const [key, value] of Object.entries(sdkOptions)) {
  if (value != null) { merged[key] = value; }
}
```

`value != null` is a loose comparison, so `[]` and `{}` survive. That matters: ADR-0006's
`tools: []` and `settingSources: []` — the two guards that disable every built-in tool and
every settings source — pass through intact.

Mapping our `buildQueryOptions()` (`apps/agent-worker/src/sdk/start-run-query.ts:408-435`)
onto the adapter config:

| ADR-0006 requirement | Our key | Passes through? |
|---|---|---|
| built-ins disabled | `tools: []` | yes (`!= null`) |
| no settings sources | `settingSources: []` | yes |
| never prompt | `permissionMode: "dontAsk"` | yes |
| executor allowlist | `allowedTools: [...EXECUTOR_ALLOWED_TOOLS]` | yes — **but mutated**, §2.2 |
| static system prompt | `systemPrompt: MYMEMO_SYSTEM_PROMPT` | yes — **but mutated**, §2.2 |
| model-client env + ephemeral config dir | `env: {…, CLAUDE_CONFIG_DIR}` | yes |
| pinned CLI path | `pathToClaudeCodeExecutable` | yes |
| executor MCP server | `mcpServers: { [EXECUTOR_SERVER_NAME]: … }` | yes — **merged with**, §2.2 |
| ADR-0004 deterministic cwd | `cwd` | yes |
| ADR-0005 SessionStore | `sessionStore` | yes |
| resume pointer | `resume` | yes — **but shadowed**, §5.2 |
| partial streaming | `includePartialMessages: true` | yes (also the adapter default) |

All of these are `Options` keys in `@anthropic-ai/claude-agent-sdk@0.3.218` — the type spans
`sdk.d.ts:1303-2035`: `allowedTools` 1356, `cwd` 1370, `tools` 1412, `env` 1432, `hooks` 1502,
`sessionStore` 1579, `includePartialMessages` 1612, `mcpServers` 1689,
`pathToClaudeCodeExecutable` 1711, `permissionMode` 1720, `resume` 1784, `settingSources` 1891,
`systemPrompt` 1998.

### 2.2 The three mutations you must suppress

**(a) `systemPrompt` is appended to.** If `input.context?.length > 0` or `hasState(input.state)`,
`buildStateContextAddendum()` output is concatenated onto the system prompt
(`src/adapter.ts:292-299`, `src/utils.ts:134-166`). ADR-0006's prompt is only static if the
caller passes `context: []` and a nullish `state`. (Secondary hazard: the concatenation is
`const base = (merged.systemPrompt as string) ?? ""` — in `0.3.218` `systemPrompt` is
`string | string[] | {…}` (`sdk.d.ts:1998`), so a non-string prompt would be corrupted into
`"[object Object]"`. Ours is a plain string, so this is latent, not live.)

**(b) `hasState({})` returns `true`.** `src/utils.ts:25-31` comments this explicitly —
`"Empty objects ({}) count as 'has state'"`. So `state: {}` (which is what
`AbstractAgent.prepareRunAgentInput` produces by default, `agent.ts:396`) triggers *all* of:
the prompt addendum; `mcp__ag_ui__ag_ui_update_state` appended to `allowedTools`
(`adapter.ts:307-312`); an `ag_ui_update_state` stub tool created (`utils.ts:271-282`); and an
`ag_ui` SDK MCP server merged into `mcpServers` alongside ours (`adapter.ts:371-386`).
**Mitigation: build `RunAgentInput` yourself with `state: null`, and do not call
`runAgent()`.**

**(c) `input.tools` mutates `allowedTools` and `mcpServers`.** Any client-supplied AG-UI tool
becomes a stub MCP tool under server `ag_ui`, auto-granted as `mcp__ag_ui__<name>`
(`adapter.ts:314-322, 349-359`). chat-api already rejects client tools, so pass `tools: []`.

**(d) `forwardedProps` is a per-run override channel with its own whitelist.**
`ALLOWED_FORWARDED_PROPS` (`src/config.ts:13-36`) permits `resume`, `forkSession`,
`resumeSessionAt`, `model`, `fallbackModel`, `temperature`, `maxTokens`, `maxThinkingTokens`,
`maxTurns`, `maxBudgetUsd`, `outputFormat`, `includePartialMessages`,
`enableFileCheckpointing`, `strictMcpConfig`, `betas` — applied directly onto the merged
options (`utils.ts:291-324`). Since the caller constructs `RunAgentInput`, this is not an
attack surface for us; it is, however, **evidence of version drift**: `temperature` does not
exist as an `Options` key in either `0.3.218` or `0.2.117` (0 occurrences in both `sdk.d.ts`
files).

### 2.3 The one option you cannot cleanly own per-run: `abortController`

`abortController` *is* an `Options` key (`sdk.d.ts:1307`), so it passes through the config
spread — **unless** `config.queryTimeoutMs` is set, in which case the adapter constructs its
own and overwrites yours at the call site (`adapter.ts:160-176`). Because it lives on the
adapter *config*, not on `run(input)`, one adapter instance can only carry one controller —
so the wrapper needs **one adapter instance per Run**. That is cheap (`clone()` exists,
`adapter.ts:117`), but it means the adapter's own `sessions` LRU/TTL machinery
(`adapter.ts:61-111`) is dead weight in our topology, where AgentCore already runs one
detached execution per process.

**Not established from a primary source:** whether the adapter is *intended* to be
instantiated per-run. Every example instantiates one adapter per route at module scope
(`examples/server.ts:22-28`) and reuses it across requests.

---

## 3. Can a caller supply cwd, SessionStore, and its own tool set?

### 3.1 cwd (ADR-0004) and SessionStore (ADR-0005): yes

Both are plain `Options` keys (`sdk.d.ts:1370` for `cwd`, `1579` for `sessionStore`) and both
survive `buildOptions`'s spread untouched — the adapter never reads or rewrites either. The
deterministic per-conversation cwd that stabilizes the SDK `projectKey` therefore works
exactly as it does today.

### 3.2 Tool set: yes for definition, no for projection

Our executor MCP server passes through and is *merged* with, not replaced by, the adapter's
`ag_ui` server (`adapter.ts:378-381`) — and if we suppress state and tools per §2.2, no
`ag_ui` server is created at all (`adapter.ts:371`). So the tool *set* is ours.

What is **not** ours is how tools are *projected*. Every non-state tool call produces
`TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` → `TOOL_CALL_RESULT`
(`adapter.ts:560-567, 526-532, 703-708, 809-817`), with the `mcp__executor__` prefix stripped
for the wire name (`utils.ts:51-60`). There is **no exclusion list**. ADR-0017's display-only
`PresentUI` — which `agent-stream.ts` "wholly excludes from Tool projection" — would appear on
the wire as an ordinary tool call. A wrapper can filter it downstream, but only by
reconstructing the `toolCallId → toolCallName` correlation itself, because `TOOL_CALL_ARGS`,
`TOOL_CALL_END` and `TOOL_CALL_RESULT` carry only `toolCallId`, never the name.

Equally, ADR-0017's atomicity — commit the Assistant completion together with its validated
`ui_payload` events, then publish `mymemo.generative_ui` — has no counterpart in the adapter.
It emits `TEXT_MESSAGE_END` and moves on. A wrapper can rebuild the grouping in its own
operator, but the adapter contributes nothing toward it.

### 3.3 Tool-result content goes on the wire verbatim

`TOOL_CALL_RESULT.content` is the stringified tool result (`adapter.ts:806-817` via
`buildAguiToolMessage`, `utils.ts:405-436`). Under ADR-0004, `LoadDocuments` returns metadata
only, so no document body leaks — but `Bash` stdout and file reads would be projected in full.
Our current `agent-stream.ts` has exactly one `TOOL_CALL_RESULT` emission site (line 404) and
applies its own bounds; the adapter applies none.

---

## 4. **The central question: is there a hook between "event formed" and "event delivered"?**

### 4.1 Inside the adapter: no. Categorically.

Every AG-UI event in the package is produced by a direct call to `subscriber.next(literal)` on
the RxJS `Subscriber` that `run()`'s `Observable` constructor handed down. There are exactly
**36** such call sites — 31 in `adapter.ts` (lines 212, 228, 244, 257, 489, 500, 511, 526,
542, 546, 560, 573, 577, 584, 630, 640, 671, 679, 703, 719, 773, 809, 847, 874, 881, 888, 911,
924, 928, 940, 968) and 5 in `handlers.ts` (69, 95, 105, 115, 128). Between the object literal
and the subscriber there is:

- no `protected emit(event)` the caller could override;
- no `onEvent` / `beforeEmit` config callback — `ClaudeAgentAdapterConfig` is
  `AgentConfig & Options` plus three numeric knobs (`types.ts:55-62`), and neither `AgentConfig`
  (`sdks/typescript/packages/client/src/agent/types.ts`) nor `Options` contains an event hook;
- no subclass seam — `translateStream` (192) and `streamMessages` (392) are `private`, and
  `run()` builds the `Observable` inline;
- no async boundary at all: the emissions are synchronous statements inside a `for await`
  loop over the SDK message stream (`adapter.ts:462`).

The `Subscriber` object itself is never exposed. It is created by RxJS when the consumer
subscribes and is passed straight into `translateStream(runInput, queryStream, subscriber)`
(`adapter.ts:181`).

**Conclusion: an in-adapter interception hook does not exist, and cannot be added without
patching internals.**

### 4.2 Outside the adapter: yes, and it is a first-class public API

`run(input)` is **public** on `ClaudeAgentAdapter` (`adapter.ts:132`) and overrides
`abstract run(input: RunAgentInput): Observable<BaseEvent>` on `AbstractAgent`
(`sdks/typescript/packages/client/src/agent/agent.ts:142`) — a *public* abstract, not a
protected one. The package's own example server calls it directly and subscribes, with no
`runAgent()` anywhere (`examples/server.ts:82-98`); the README shows the same
(`README.md`, "Usage"). So consuming the raw `Observable` is the documented, supported path,
and the wrapper owns the entire operator chain from the first `next()` onward:

```ts
adapter.run(input).pipe(
  concatMap(async (event) => {
    await commitToPostgres(event);   // durable first
    await publishToStream(event);    // then visible
    return event;
  }),
).subscribe({ … });
```

`concatMap` subscribes to the next inner observable only after the previous one completes, so
**ordering and commit-before-publish are guaranteed**. This is the ADR-0014 shape.

Two additional, genuinely-public seams exist in `@ag-ui/client@0.0.58` but are **not usable
for us as the primary hook**:

- **`AbstractAgent.use(middleware)`** (`agent.ts:150-156`) with
  `Middleware.run(input, next): Observable<BaseEvent>` (`middleware/middleware.ts:24-34`).
  This is a real, exported interception seam — but it is only wired into `runAgent()`
  (`agent.ts:196-218`), `connectAgent()`, and the legacy bridge (`agent.ts:700-720`). Calling
  `adapter.run(input)` directly bypasses the middleware chain entirely. Using it means opting
  into `runAgent()`'s whole pipeline (`transformChunks`, `verifyEvents`, `defaultApplyEvents`,
  in-memory `messages`/`state` accumulation, subscriber fan-out) — more machinery than we
  want, and `runAgent()` is where `prepareRunAgentInput` injects `state: {}` (§2.2b).
- **`AgentSubscriber` hooks** passed to `runAgent(params, subscriber)` (`agent.ts:158-185`).
  Same objection, plus these are state/message-oriented rather than raw-event-oriented.

Note also that the interceptor `concatMap` is exactly the shape `@ag-ui/client`'s own
`Middleware.runNextWithState` uses (`middleware/middleware.ts:63-77`) — so this pattern is the
library's own idiom, not a workaround.

### 4.3 But it is an ordering seam, not a backpressure seam

RxJS `Observable`s have no backpressure. `subscriber.next()` pushes into the operator chain
and returns; `concatMap` enqueues the value in an unbounded internal buffer whenever an inner
observable is still in flight. The adapter's `for await (const rawMessage of messageStream)`
loop (`adapter.ts:462`) therefore keeps pulling from the Claude SDK **regardless of whether
our Postgres commits have kept up**.

Verified empirically (Bun + `rxjs@7.8.1`, reproducing the adapter's exact producer shape — an
async loop calling `subscriber.next()` inside `new Observable(sub => {…})` with no returned
teardown — piped through `concatMap` with a 20 ms async "commit"):

```
produce 0 … produce 9        ← all ten produced first
  commit+publish 0 … 9       ← commits then drain in order
```

All 10 events were produced before the first commit completed. Ordering held perfectly;
throttling did not exist.

Consequences for the canary lane:

- **Unbounded in-memory queue.** If Postgres slows, events accumulate in the operator buffer
  with no ceiling. Our current `agent-stream.ts` gets flow control for free because it
  `await`s inside its own `for await` over the SDK stream.
- **No fail-fast.** ADR-0005's "`mirror_error` is a fail-fast bounded stop that aborts
  Tool/E2B work" cannot be enforced synchronously. By the time the wrapper sees the failure,
  the adapter has already produced — and possibly the SDK has already *executed* — further
  work. The wrapper can only react after the fact (§4.4).
- **A durable-write failure cannot veto an emission.** It can only stop *subsequent*
  emissions from being published, because upstream events are already formed and buffered.

*(A genuinely blocking, awaited hook does exist — but one layer down, in the Claude Agent SDK
itself: `Options.hooks` (`PreToolUse` etc., `sdk.d.ts:1502`) and `Options.canUseTool`
(`sdk.d.ts:1361`) are awaited by the SDK and can deny. Both pass through the adapter's config
spread untouched. They give true backpressure at **tool** granularity, not at AG-UI-event
granularity. Whether that granularity is sufficient for ADR-0014 is a design call, not a
research finding.)*

### 4.4 Unsubscribing does not stop the query

`run()`'s `Observable` constructor callback returns nothing (`adapter.ts:133-189` — no
`return () => …`), so RxJS registers **no teardown**. Unsubscribing marks the subscriber
closed and silently discards further `next()` calls; the `for await` loop and the underlying
`query()` keep running to completion.

Verified empirically with the same harness: after `unsubscribe()` at 25 ms, the producer ran
**4 more iterations** with `subscriber.closed === true`, all silently dropped.

The only supported stop is `adapter.interrupt()` (`adapter.ts:126-130`), which awaits
`q.interrupt()` across `activeQueries`, or supplying your own `abortController` via config
(§2.3). Both are out-of-band relative to the stream. For ADR-0023's ownership-loss and
shutdown reconciliation, the wrapper must therefore hold an explicit handle and call it —
tearing down the subscription is not enough.

There is one related leak: the frontend-tool "halt" path `break`s out of the message loop
(`adapter.ts:696-697`, `785-786`) and lets `run()` complete **without** interrupting the still
running query. We would not hit it (it requires `input.tools`), but it shows the lifecycle is
not fully owned by the Observable.

---

## 5. SDK-message → AG-UI-event mapping, and its coupling to the SDK version

### 5.1 The mapping

Read from the `for await` dispatch in `streamMessages` (`adapter.ts:462-902`):

| SDK message | Branch | AG-UI events emitted |
|---|---|---|
| `stream_event` / `message_start` | 476-480 | *(none — `TEXT_MESSAGE_START` deferred until real text, to avoid empty thinking-only messages)* |
| `stream_event` / `content_block_start` `thinking` | 539-550 | `REASONING_START`, `REASONING_MESSAGE_START` |
| `stream_event` / `content_block_start` `tool_use` | 551-568 | `TOOL_CALL_START` (name MCP-prefix-stripped, `parentMessageId` = current message) |
| `content_block_delta` / `text_delta` | 485-507 | `TEXT_MESSAGE_START` (first only), `TEXT_MESSAGE_CONTENT` |
| `content_block_delta` / `thinking_delta` | 508-516 | `REASONING_MESSAGE_CONTENT` |
| `content_block_delta` / `signature_delta` | 517-521 | *(accumulated, flushed as `REASONING_ENCRYPTED_VALUE`)* |
| `content_block_delta` / `input_json_delta` | 522-534 | `TOOL_CALL_ARGS` |
| `content_block_stop` | 570-714 | `REASONING_MESSAGE_END`, `REASONING_END`, `REASONING_ENCRYPTED_VALUE`, `STATE_SNAPSHOT` (state tool only), `TOOL_CALL_END` |
| `message_stop` | 715-726 | `TEXT_MESSAGE_END` |
| `assistant` (complete) | 738-789 | fallback `TOOL_CALL_START`/`ARGS`/`END` for unseen `tool_use` blocks (`handlers.ts:105-133`) |
| `user` (tool results) | 791-821 | `TOOL_CALL_RESULT` |
| `system` (any subtype) | 823-852 | `CUSTOM { name: "system:<subtype>", value: data ?? raw }` |
| `result` | 854-901 | populates `RUN_FINISHED.result`; synthesizes a whole `TEXT_MESSAGE_*` triple if nothing streamed |
| *(end of stream)* | 959-972 | `MESSAGES_SNAPSHOT` (input messages + all run messages) |
| *(wrapper)* | 212, 244, 257 | `RUN_STARTED`, `RUN_FINISHED`, `RUN_ERROR` |

Notably `MESSAGES_SNAPSHOT` re-emits the **entire** conversation (input + run) as one event
before `RUN_FINISHED`. Against ADR-0014's per-event durable pipeline that is a large,
wholly redundant payload.

### 5.2 Session/resume handling is duplicated in-adapter

The adapter keeps its own `Map<threadId, {sessionId, lastUsed, active}>`, harvests
`session_id` from the `system`/`init` message (`adapter.ts:829-843`), and on the *next*
`run()` for that thread injects `forwardedProps.resume` (`adapter.ts:143-154`), which
`applyForwardedProps` then writes onto `Options.resume`. This is a second, in-memory
implementation of what ADR-0005's `conversation_runtime.agent_session_id` pointer already
does durably. In the AgentCore topology (one detached execution per process) the map is
always empty at the start of a Run, so **our** `forwardedProps.resume` survives — but the
duplication is latent, process-local, and untestable from outside.

### 5.3 `mirror_error` is downgraded, not fatal

`@anthropic-ai/claude-agent-sdk@0.3.218` emits `SDKMirrorErrorMessage`
(`sdk.d.ts:4044-4056`: `{type:'system', subtype:'mirror_error', error, key, uuid, session_id}`)
when `SessionStore.append()` fails after bounded retry and the batch is **dropped**. The
adapter routes it through the generic `system` branch and emits
`CUSTOM { name: "system:mirror_error", value: <raw message> }` (`adapter.ts:847-851` — there
is no `data` field on `SDKMirrorErrorMessage`, so the `data ?? raw` fallback puts the whole
message in `value`). The run continues.

Our `agent-stream.ts:85-104` treats the same signal as a fail-fast bounded stop that aborts
Tool/E2B work and prevents the resume pointer from advancing. **A wrapper can recover this**:
the `CUSTOM` event is visible downstream and carries the full raw payload, so the interceptor
can detect it and call `adapter.interrupt()`. But the detection is string-matching a `CUSTOM`
event name that the adapter's generic branch produces incidentally — not a contract.

### 5.4 Version coupling: our pin is out of range

- **Declared peer:** `"@anthropic-ai/claude-agent-sdk": "^0.2.58"` (`package.json:38`, both on
  `main` and in published `0.0.3`). **We pin `0.3.218`** (`apps/agent-worker/package.json:23`).
  `^0.2.58` does not admit `0.3.x`.
- **How tightly is the mapping coupled?** Loosely, in a way that cuts both directions. The
  hot path reads the raw Anthropic streaming-event shape (`message_start`,
  `content_block_delta.text_delta`, `input_json_delta`, `message_stop`) via
  `Record<string, unknown>` casts (`adapter.ts:466-473`) rather than the SDK's discriminated
  unions — so it will not break on additive SDK changes, but it will also silently ignore new
  message types. Only five SDK types are imported (`Query`, `Options`,
  `SDKResultMessage`, `SDKPartialAssistantMessage`, `SDKAssistantMessage`, `SDKUserMessage`,
  `adapter.ts:10-17`), and `Options` is re-exported wholesale as part of the config type.
- **Practical implication:** the adapter would very likely *run* against `0.3.218` (all the
  keys it forwards exist there — checked against `sdk.d.ts`), but installing it under our pin
  requires overriding the peer range, and every SDK feature added since `0.2.58` is unmapped
  by construction. `Options` is structurally compatible enough that `ClaudeAgentAdapterConfig`
  would typecheck against `0.3.218` — but the `temperature`/`maxTokens` entries in
  `ALLOWED_FORWARDED_PROPS` (§2.2d) are already dead keys in both `0.2.117` and `0.3.218`,
  which is the drift showing.

**Not established from a primary source:** whether the maintainers intend to widen the peer
range. No issue or PR was found addressing it; the last package.json change under
`integrations/claude-agent-sdk/typescript` was the 2026-06-16 LICENSE-coverage commit.

---

## 6. Release cadence and maturity: the TypeScript integration lags the Python one badly

**Commit counts on `main`, whole-history, per integration path:**

| Path | Commits | Last commit | Last *functional* change |
|---|---|---|---|
| `integrations/claude-agent-sdk/typescript` | **13** | 2026-06-16 (LICENSE housekeeping) | **2026-05-22** (`feat: declare headers property for forward compat`) |
| `integrations/claude-agent-sdk/python` | **49** | 2026-07-17 | 2026-07-14 |

Published versions: TypeScript `0.0.3` (2026-05-26). Python reached `0.1.5` on 2026-06-05 and
kept landing fixes for six more weeks.

### 6.1 Fixes that landed in Python and never in TypeScript

Three of them are directly load-bearing for a durable-event runtime, and I confirmed each is
still un-fixed by reading the TS source:

1. **`fix(claude-agent-sdk): emit RUN_ERROR from run() in place of RUN_FINISHED on errored
   turns`** (Python, 2026-07-14). The TS adapter emits `RUN_FINISHED` unconditionally after
   the message loop (`adapter.ts:244-249`) and merely stuffs `isError` into
   `RUN_FINISHED.result` (`adapter.ts:857-869`). `RUN_ERROR` is emitted **only** when an
   exception is thrown (`adapter.ts:257-262`). An errored SDK result therefore reaches an
   AG-UI consumer as a **successful** run. For a runtime that terminalizes Runs from the event
   stream, that is a correctness bug we would have to work around in the wrapper.
2. **`fix(claude-agent-sdk): use msg_id for tool-call parent_message_id on fallback path`**
   (Python, 2026-07-10). In the TS fallback path, `handleToolUseBlock` is called with
   `assistantMsg.parent_tool_use_id` (`adapter.ts:756-763`) and assigns it to
   `parentMessageId` (`handlers.ts:111`) — the same confusion the Python fix corrected.
3. **`fix(claude-agent-sdk): dedup errored-turn assistant messages`** (Python, 2026-07-10).
   No TS counterpart.

Also Python-only: run serialization per thread, query-timeout defaults, worker fan-out on
death, `MESSAGES_SNAPSHOT` bare-string tool-result normalization (all 2026-06-05).

### 6.2 Reading of maturity

The TypeScript integration is best characterised as a **demo-grade port kept alive for the
AG-UI Dojo**. Its five examples are Dojo routes (`README.md`, "Examples" table); its only test
file is `adapter.headers.test.ts` (213 lines, covering the non-functional `headers` property);
it has no documentation page; and its correctness fixes are landing in the sibling language
and not being backported. That is not an argument that the code is bad — it reads carefully,
with real attention to hanging-event cleanup (`adapter.ts:903-957`) — but it *is* an argument
that "depend on the released package and ride upstream's protocol-version treadmill" (map
#462's standing preference) buys less here than the preference assumes. **Upstream's
TypeScript treadmill for this specific package has not moved since May.**

---

## 7. Weight of the RxJS dependency

| Package | Role | Unpacked | Files | Its own deps |
|---|---|---|---|---|
| `rxjs@7.8.1` | adapter's only runtime dep | 4.50 MB | 2277 | `tslib` |
| `@ag-ui/client@0.0.58` | **required peer** (adapter imports `AbstractAgent`, `EventType`, `randomUUID` — `adapter.ts:6`) | 630 KB | 11 | `@ag-ui/core`, `@ag-ui/encoder`, `@ag-ui/proto`, `rxjs`, `uuid`, `@types/uuid`, `zod`, `fast-json-patch`, `untruncate-json`, `compare-versions` |
| `@ag-ui/core@0.0.58` | already ours (`^0.0.57` in 3 packages) | 1.16 MB | 11 | `zod` |
| `@ag-ui/proto@0.0.58` | pulled by client | 545 KB | 12 | `@bufbuild/protobuf`, `@protobuf-ts/protoc` |
| `@ag-ui/encoder@0.0.58` | pulled by client | 44 KB | 11 | `@ag-ui/proto`, `@ag-ui/core` |
| `@anthropic-ai/sdk` | peer `>=0.50.0` | — | — | (transitive of the Claude SDK already) |

`rxjs` appears **nowhere** in this repo today: zero matches in any workspace `package.json`
and zero `"rxjs` occurrences in `bun.lock`. `@ag-ui/client` is likewise absent — we depend on
`@ag-ui/core` only, in `packages/live-text`, `apps/agent-worker`, and `apps/chat-api`.

Three practical notes, all verified rather than assumed:

- **The 4.5 MB / 2277 files is the published tarball, not what ships.** rxjs 7 is ESM +
  CJS + UMD + per-operator entry points; a bundler tree-shakes it hard. The AgentCore runtime
  image is Linux ARM64 and does bundle, so the marginal image cost is far below the tarball
  size. I did **not** measure the bundled delta — that would need a real build and is out of
  scope for this ticket.
- **rxjs 7.8.1 is pinned exactly** by the adapter (`"rxjs": "7.8.1"`, not `^7.8.1`) and was
  published 2023-04-26; 7.8.2 is current. A Bun install will resolve 7.8.1 for the adapter and
  possibly a second copy for `@ag-ui/client` (which declares `7.8.1` too, so likely deduped).
  Given this repo's documented single-Drizzle-instance invariant (AGENTS.md), a duplicated
  peer-context copy of rxjs is the kind of thing worth checking at install time — RxJS
  `instanceof` checks across two copies behave badly.
- **`@ag-ui/proto` → `@protobuf-ts/protoc` is a code-generation toolchain in a runtime
  dependency chain.** It is only reachable via `@ag-ui/client`'s dependency on `@ag-ui/proto`,
  which the adapter does not itself import — but package managers install it anyway.

---

## 8. What a wrap would and would not preserve

| Runtime responsibility | Preserved by wrapping? | How |
|---|---|---|
| ADR-0006 fail-closed query options | **Yes** | adapter config spread (§2.1), with three input guards (§2.2) |
| ADR-0004 deterministic cwd | **Yes** | `Options.cwd` passthrough |
| ADR-0005 Postgres SessionStore | **Yes** | `Options.sessionStore` passthrough |
| ADR-0005 fail-fast on `mirror_error` | **Degraded** | detectable as `CUSTOM system:mirror_error`, but only reactively (§5.3) |
| Own MCP/executor tool set | **Yes** | `Options.mcpServers` merged, not replaced (§3.2) |
| ADR-0017 `PresentUI` display-only exclusion | **No** | must be re-filtered downstream, reconstructing id→name (§3.2) |
| ADR-0017 ui_payload atomic commit-then-publish | **No** | must be rebuilt in the wrapper's operator (§3.2) |
| ADR-0014 commit-before-publish **ordering** | **Yes** | `concatMap` on the public Observable (§4.2) |
| ADR-0014 commit-before-publish **flow control** | **No** | RxJS has no backpressure; unbounded buffer (§4.3) |
| ADR-0023 shutdown / ownership-loss abort | **Partial** | needs explicit `interrupt()` or injected `abortController`; unsubscribe is inert (§4.4) |
| Terminalize `error` on an errored turn | **No** | adapter emits `RUN_FINISHED` (§6.1) |
| Bounded tool-result payloads | **No** | full result text on the wire (§3.3) |
| Structured logging | **No** | 31 unconditional `console.*` calls (19 `adapter.ts`, 6 `utils.ts`, 6 `handlers.ts`), no logger seam |
| Message-id ownership | **No** | ids are `randomUUID()` inside the adapter |

---

## Sources

All fetched or read 2026-08-14.

**Adapter source** (`ag-ui-protocol/ag-ui@main`, HEAD `0c0b88a`; `adapter.ts` at `4bd4f95`,
2026-05-22), via `raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/integrations/claude-agent-sdk/typescript/`:
- `src/adapter.ts` (974 lines) — https://github.com/ag-ui-protocol/ag-ui/blob/main/integrations/claude-agent-sdk/typescript/src/adapter.ts
- `src/utils.ts` (436), `src/handlers.ts` (137), `src/types.ts` (86), `src/config.ts` (46), `src/index.ts` (23)
- `package.json`, `README.md`, `examples/server.ts`, `examples/agentic_chat.ts`

**AG-UI client SDK** (`agent.ts` at `7183701`, 2026-08-07), via
`raw.githubusercontent.com/ag-ui-protocol/ag-ui/main/sdks/typescript/packages/client/src/`:
- `agent/agent.ts` (736 lines), `agent/subscriber.ts`, `agent/types.ts`
- `middleware/middleware.ts`, `middleware/index.ts`, `index.ts`, `package.json` (v0.0.58)

**AG-UI docs** — https://github.com/ag-ui-protocol/ag-ui/blob/main/docs/integrations.mdx
(Claude Agent SDK adapter absent); https://docs.ag-ui.com/integrations/claude-agent-sdk → HTTP 404.

**npm registry** (`registry.npmjs.org`) — `@ag-ui/claude-agent-sdk` (versions/time/peerDeps),
`@ag-ui/client`, `@ag-ui/core`, `@ag-ui/proto`, `@ag-ui/encoder`, `rxjs` (sizes/deps).

**GitHub API** — commit history for `integrations/claude-agent-sdk/typescript` (13 commits)
and `integrations/claude-agent-sdk/python` (49 commits).

**Claude Agent SDK typings** — `@anthropic-ai/claude-agent-sdk@0.3.218` `sdk.d.ts`
(`Options` 1303-2035; `PermissionMode` 2073; `SettingSource` 6581; `SessionStore` 4759-4800;
`SDKMirrorErrorMessage` 4044-4056), and `0.2.117` for drift comparison — both resolved from
this repo's `node_modules/.bun/`.

**This repo** — `apps/agent-worker/src/sdk/start-run-query.ts:408-435` (ADR-0006 options),
`apps/agent-worker/src/sdk/agent-stream.ts:85-104, 148-149, 404` (`mirror_error` fail-fast,
`PresentUI`/`ui_payload` handling, single `TOOL_CALL_RESULT` site),
`apps/agent-worker/package.json:22-23`, `bun.lock`.

**Runtime experiment** (§4.3, §4.4) — Bun + `rxjs@7.8.1`, reproducing the adapter's producer
shape (async loop calling `subscriber.next()` inside `new Observable(sub => {…})` with no
returned teardown) piped through `concatMap` with a 20 ms async commit. Results: all 10 events
produced before the first commit resolved (ordering held, no throttling); after
`unsubscribe()`, the producer ran 4 further iterations with `subscriber.closed === true`.
