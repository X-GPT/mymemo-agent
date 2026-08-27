# Claude Harness inside MyMemo AgentCore: local session feasibility

**Researched:** 2026-08-26

**Updated scope:** Claude Code is the only AI SDK Harness adapter. Every Claude built-in tool is disabled. The only model-callable tools are MCP-shaped host tools whose implementations operate on the existing per-Conversation E2B sandbox.

## Decision summary

The exact **host-driven** design is feasible and is the best fit if MyMemo is willing to own a small `HarnessV1` adapter: keep `@anthropic-ai/claude-agent-sdk` in the trusted AgentCore process, keep every Claude built-in disabled, and expose only host tools whose effects go through the Conversation's E2B clients. This reuses MyMemo's current execution model and needs no Claude bridge, loopback port, `localWorkspace`, or bridge bootstrap.

The caller-owned local-session design below remains a feasible alternative when the priority is using Vercel's upstream `createClaudeCode` adapter without owning the Claude-to-Harness protocol translation. It is bridge-backed, not host-driven.

For that upstream alternative, use a caller-owned AI SDK basic `SandboxSession` backed by local Node/Bun filesystem and child-process APIs. Pass it to `HarnessAgent.createSession({ sandboxSession })`, and configure the Claude adapter with a fixed loopback bridge endpoint such as `ws://127.0.0.1:<port>`. This is **not** using AgentCore as the untrusted sandbox; it is using AgentCore as the trusted host for the Claude bridge.

This preserves MyMemo's current trust boundary **if and only if**:

- `activeTools` is an allowlist containing only MyMemo's E2B-backed user tools, which automatically excludes every present and future Claude built-in;
- no untrusted/native `mcpServers` are configured directly on `createClaudeCode`;
- every tool implementation ignores the local `experimental_sandbox` capability and explicitly uses the Conversation's E2B client;
- any provider-executed built-in tool event is treated as a security failure, never approved;
- the Claude adapter, bridge, Agent SDK, and their installed packages are treated as trusted code with access to the AgentCore container.

The result is materially smaller than an AgentCore command-API sandbox provider. It avoids AWS command/file/port adapters entirely. The main work moves to the runtime image, process cleanup, persistence across AgentCore compute replacement, and security regression tests.

## True Host-Driven Runtime

**Verdict: yes, with a custom adapter.** Vercel defines the preferred host-driven shape as a runtime created in the host Node process, with remote file and shell operations translated to the supplied sandbox session; it explicitly requires no in-sandbox bridge and no sandbox port ([Vercel Harness architecture](https://github.com/vercel/ai/blob/main/architecture/harness-abstraction.md#host-driven-runtime)). That describes MyMemo more closely than `createClaudeCode`: the Claude Agent SDK already runs directly in AgentCore, while all prompt-directed file and command effects are implemented by E2B-backed clients.

The qualification is important: this is a true host-driven Harness only while Claude's local `cwd`/home is adapter-private state and **not** the user workspace. The supplied E2B `sandboxSession` and its `sessionWorkDir` must remain the semantic workspace reached by the custom tools. If a future Claude feature requires native local workspace, process, or home access, Vercel's architecture says that feature requires bridge mode instead ([runtime-placement boundary](https://github.com/vercel/ai/blob/main/architecture/harness-abstraction.md#harness-and-sandbox-interaction)).

```text
HarnessAgent (AgentCore host)
  -> custom MyMemo Claude HarnessV1
       -> Claude Agent SDK query() (AgentCore host; native tools = [])
            -> in-process MCP relay for this turn
                 -> Harness tool-call (providerExecuted = false)
                      -> HarnessAgent executes MyMemo ToolSet
                           -> existing bounded/audited E2B clients
```

This is **not** a configuration of `createClaudeCode`. It is a new `HarnessV1` implementation around MyMemo's current direct SDK integration. The adapter should declare `specificationVersion: 'harness-v1'`, a stable `harnessId`, and `builtinTools: {}`; omit built-in approval/filtering claims and `getBootstrap`; optionally publish a schema for its serialized Claude session state; and implement `doStart()` ([`HarnessV1` contract](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1.ts)). A caller-owned **E2B-backed basic** `SandboxSession` is the honest session to pass to `HarnessAgent.createSession`: no network extension or provider is needed, and the object supplied to host tools as `experimental_sandbox` then represents the same E2B workspace as their existing bounded clients. The adapter must never stop or destroy that caller-owned sandbox ([start options](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-session.ts#L15-L85)).

### Concrete `HarnessV1` implementation surface

| Required surface | MyMemo implementation |
|---|---|
| `doStart(options)` | Validate `resumeFrom`/`continueFrom`, bind `sessionId`, the supplied E2B session, and the persisted native Claude session id, then return the session object. Do not start a bridge. |
| `doPromptTurn(options)` | Convert each `HarnessV1ToolSpec` (`name`, description, JSON Schema) into an in-process Claude MCP tool, call `query()`, and translate SDK messages into ordered `HarnessV1StreamPart` events. Reject unsupported JSON response formats explicitly. |
| `HarnessV1PromptControl.submitToolResult()` | Resolve the pending MCP handler for that `toolCallId`, returning the host tool's output/error to Claude; `done` resolves only after all stream events are emitted. `submitUserMessage` and built-in approval support can be omitted initially. |
| `doCompact()` | Required method; throw `HarnessCapabilityUnsupportedError` until the pinned Claude SDK exposes a tested manual-compaction mapping. |
| `doContinueTurn(options)` | Continue without a new user prompt. Reattach in-process when possible; after compute replacement, re-drive from persisted Claude state and durably inject any pending host-tool result. The V1 contract permits lossy recomputation for host-resident runtimes, but not dropping a submitted tool result. |
| `doSuspendTurn()` | Interrupt/close host-side consumption, persist the Claude session id plus the adapter cursor/journal needed to re-drive the unfinished turn, and return `continue-turn` state. |
| `doDetach()` | Between turns, return `resume-session` state without deleting the E2B sandbox or Claude transcript. |
| `doStop()` | Persist resumable state, interrupt/close the active SDK query, and return `resume-session` state. |
| `doDestroy()` | Interrupt/close SDK work and discard adapter-local resumability state; leave the caller-owned E2B lifecycle to MyMemo. |

Those methods are mandatory on every `HarnessV1Session`; the official contract specifically notes that host-resident runtimes may have to recompute the in-flight tail on `doContinueTurn()` ([session contract](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-session.ts#L167-L272)). The stream translation must cover start, text/reasoning blocks, host tool calls/results, step and turn finish with usage, and errors ([stream-part contract](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-stream-part.ts)).

The tool loop should use the Harness host-tool rail rather than execute tools opaquely inside the adapter. `HarnessV1ToolSpec` explicitly says the adapter translates tool metadata for its native runtime, emits a tool call, and waits; it does not execute the tool itself ([tool-spec source](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-tool-spec.ts)). `HarnessAgent` validates and executes any `providerExecuted: false` call, passes the supplied sandbox as `experimental_sandbox`, and returns the result through `submitToolResult` ([host-tool execution](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/run-prompt.ts#L1108-L1174)). This gives MyMemo native Harness tool approval, continuation, telemetry, and stream semantics while the actual handlers retain their current E2B bindings.

MyMemo already has most of the execution core. Its pinned Claude Agent SDK is `0.3.233` ([runtime package](../../apps/agentcore-runtime/package.json)); `buildQueryOptions()` already sets `tools: []`, `settingSources: []`, `permissionMode: 'dontAsk'`, allows only the qualified executor MCP names, and installs one in-process MCP server ([current query options](../../apps/agentcore-runtime/src/sdk/start-run-query.ts)). `createRunMcpServer()` and the workspace handlers already close over the Run's fenced, bounded, audited E2B file/command clients ([current MCP tools](../../apps/agentcore-runtime/src/sdk/run-tools.ts), [workspace tools](../../apps/agentcore-runtime/src/sdk/workspace-tools.ts)). The migration work is to split the framework-neutral tool catalog from the Anthropic wrappers, replace the MCP handlers with pending-result resolvers, and translate the existing SDK stream into the V1 stream contract; the current `agent-stream.ts` provides parsing behavior but emits MyMemo Run events rather than `HarnessV1StreamPart` ([current stream adapter](../../apps/agentcore-runtime/src/sdk/agent-stream.ts)).

| Design | Where Claude SDK runs | E2B access | Bridge/port | Assessment |
|---|---|---|---|---|
| **Custom Host-Driven `HarnessV1`** | AgentCore host, direct SDK | Harness host tools call E2B | None | **Recommended**; matches current MyMemo architecture, but MyMemo owns protocol/lifecycle correctness. |
| `createClaudeCode` + caller-owned local session | AgentCore local bridge | Harness host tools call E2B | Required loopback bridge | Lower adapter ownership; adds bridge/bootstrap/process state. |
| `createClaudeCode` + `localWorkspace` | AgentCore local bridge | Harness host tools call E2B | Required, managed by local workspace | Convenience wrapper for the same bridge-backed design; not isolation and not host-driven. |

Estimated effort is **5–8 engineer-days for a spike** (one text turn, one E2B host tool, stream/usage mapping, stop/detach, built-in invariant test) and **3–5 engineer-weeks for production** (complete event mapping, durable resume/suspend/continue with pending results, structured-output policy, tool catalog migration, security/telemetry/load tests). The hardest item is cross-process continuation, not E2B execution. Recommendation: spike this host-driven adapter first and keep the existing direct SDK path as the rollback; use `createClaudeCode` only if maintaining the V1 translation proves costlier than accepting its bridge/runtime-image requirements.

## Bridge-backed alternative: `createClaudeCode` in AgentCore

```text
Chat API -> dispatch -> trusted AgentCore Runtime (one Conversation session)
                         |-- HarnessAgent
                         |-- caller-owned LocalSandboxSession
                         |     |-- fs/promises + streams
                         |     |-- child_process.spawn + process groups
                         |     `-- ws://127.0.0.1:<fixed-port>
                         |-- Claude Code bridge + Claude Agent SDK
                         `-- in-process "harness-tools" MCP relay
                               `-- host tool execute() -> E2B API
                                                     `-- untrusted Bash/files/workspace
```

The local `SandboxSession` is a compatibility adapter for trusted bridge bootstrap and process control. It must not be described or relied upon as MyMemo's security sandbox. E2B remains the only place where prompt-injectable commands and filesystem operations run.

That matches MyMemo's documented `Split runtime`: the trusted AgentCore loop owns credentials and service coordination; E2B isolates prompt-injectable execution ([AgentCore Runtime guidance](../agents/agentcore-runtime.md), [Security boundaries](../agents/security.md), [ADR-0031](../adr/0031-make-agentcore-the-sole-execution-runtime.md)).

## Why a basic caller-owned session is sufficient

`HarnessAgent.createSession` accepts either a provider-managed network session or an existing basic `Experimental_SandboxSession`. When the caller supplies the session, the caller retains its lifecycle; Harness does not stop or destroy the surrounding AgentCore runtime ([Vercel `HarnessAgent` source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L204-L458)).

The current Claude adapter explicitly supports this mode. With a basic session, `createClaudeCode` requires both:

- `port: <number>`
- `portEndpoint: { url: 'ws://127.0.0.1:<number>' }`

It then starts the bridge through `sandboxSession.spawn()` and connects through that endpoint. The bridge token is added as an `agent_bridge_token` query parameter ([Vercel Claude adapter source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L817-L1140), [basic-session validation](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1144-L1205)).

Because bridge and caller are in the same AgentCore microVM, the endpoint is ordinary loopback. AgentCore's public `/ws` route, SigV4 WebSocket signing, arbitrary port publication, `InvokeAgentRuntimeCommand`, and `StopRuntimeSession` are not involved.

The local implementation only needs the AI SDK base contract:

- `description` and a stable `defaultWorkingDirectory`
- text, bytes, and stream file reads/writes
- `run({ command, workingDirectory?, env?, abortSignal? })`
- `spawn(...)` returning stdout/stderr byte streams, `wait()`, and `kill()`

The authoritative type is Vercel's [`SandboxSession`/`SandboxProcess` source](https://github.com/vercel/ai/blob/main/packages/provider-utils/src/types/sandbox.ts). Implement `run` on top of the same `spawn` primitive; use a real POSIX shell because the Claude bootstrap and adapter issue shell command strings.

## Tool routing and the trust boundary

### What the current Claude adapter actually does

`HarnessAgent` executes user-defined tools on the host and sends their results back to the adapter. Built-ins such as Claude's Bash normally execute inside the Claude runtime ([Vercel `HarnessAgent` source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L85-L117)).

For Claude, the bridge turns user tools into an in-process MCP server named `harness-tools`. A model tool call is emitted to the host with `providerExecuted: false`; the bridge waits for the host result and returns it to Claude ([Vercel Claude bridge source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/index.ts#L231-L286)). This is a clean seam for MyMemo: each `execute()` callback resolves the Conversation's E2B sandbox and runs the operation there.

Do not confuse these HarnessAgent `tools` with `createClaudeCode({ mcpServers })`. Native MCP server configuration is passed directly into the Claude Agent SDK inside the trusted bridge. Such a server would execute or be contacted from AgentCore unless its own implementation deliberately proxies to E2B. For the proposed design, leave adapter-level `mcpServers` empty and use only HarnessAgent user tools.

### Disable all native tools with an allowlist

Use `activeTools` containing only the user-tool names, rather than maintaining an `inactiveTools` denylist. Harness resolves this into an allow-mode built-in filter with an empty native allowlist and separately keeps only the named user tools ([Vercel filtering implementation](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/tool-filtering.ts)). The Claude bridge passes the resolved native set as the Agent SDK `tools` option and inactive names as `disallowedTools` ([Vercel Claude bridge source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/index.ts#L294-L365)).

Illustrative shape:

```ts
const e2bTools = createConversationE2BTools(/* dependencies */);
const harness = createClaudeCode({
  port: 43127,
  portEndpoint: { url: 'ws://127.0.0.1:43127' },
  mcpServers: {},
  env: { ENABLE_TOOL_SEARCH: 'false' },
});

const agent = new HarnessAgent({
  harness,
  tools: e2bTools,
  activeTools: Object.keys(e2bTools),
  // Built-ins are filtered, not made safe by this permission mode.
  permissionMode: 'allow-all',
});

const session = await agent.createSession({
  sessionId: conversationId,
  sandboxSession: localBridgeSession,
  resumeFrom,
});
```

`ENABLE_TOOL_SEARCH=false` needs a live compatibility test and version pin. Claude Code may defer MCP tools and ask its native `ToolSearch` tool to hydrate them. Disabling every built-in also disables `ToolSearch`; preloading MCP definitions avoids that dependency. This behavior and workaround are documented in Vercel's official [Claude adapter issue #16694](https://github.com/vercel/ai/issues/16694), and current main recognizes `ToolSearch` as a native built-in ([Vercel Claude adapter source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L496-L503)).

### What this does and does not protect

It protects against the normal model tool-call path reaching local Bash, local files, web fetch, subagents, worktrees, skills, or other Claude built-ins. The only advertised model capabilities are audited MyMemo tools, and their effects occur in E2B.

It does **not** create an OS boundary inside AgentCore:

- the Claude bridge and Agent SDK are ordinary trusted processes in the same microVM as MyMemo credentials;
- a compromised npm package, malicious adapter update, or bug allowing raw local execution can read the container environment and execution-role credentials;
- `HarnessAgent` supplies the caller-owned session as `experimental_sandbox` to user-tool execution. MyMemo tools must not call it; route every prompt-derived path/command to E2B explicitly;
- MCP tool outputs return through the trusted bridge and may be written to Claude's local transcript, so secrets from E2B responses must be minimized and redacted;
- a model-emitted `providerExecuted: true` built-in call is an invariant violation. Fail the turn and alert rather than entering an approval path.

AgentCore's microVM isolation is between different `runtimeSessionId` values, not between processes inside one session. AWS says commands and processes in a Runtime session share its container, filesystem, environment, and credentials ([AWS sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [AWS Runtime security best practices](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-security-best-practices.html)). The proposed safety therefore depends on capability filtering plus trusted dependencies, while E2B remains the hard boundary for model-directed effects.

## MyMemo's AI SDK `ToolSet` adapter work

MyMemo already has the right handlers, but not the shape `HarnessAgent` consumes. `buildRunTools()` currently returns Anthropic `SdkMcpToolDefinition[]`, and `createRunMcpServer()` wraps them in the SDK-native `mymemo-executor` MCP server ([current run tools](../../apps/agentcore-runtime/src/sdk/run-tools.ts), [workspace tools](../../apps/agentcore-runtime/src/sdk/workspace-tools.ts)). The handlers are already bound per Run to the E2B file/command clients, frozen document scope, audit hooks, limits, and taint handling.

For HarnessAgent, expose the same handlers as an AI SDK `ToolSet` passed through `new HarnessAgent({ tools })`. Do not pass the existing `createRunMcpServer()` through `createClaudeCode({ mcpServers })`; that would bypass the HarnessAgent host-tool rail and its active-tool filtering.

The maintainable implementation is a small framework-neutral definition layer:

```text
RunToolDefinition { name, description, Zod schema, execute }
                 |-> Anthropic SDK MCP definition (legacy path)
                 `-> AI SDK ToolSet entry (Harness path)
```

This avoids trying to reverse-engineer schemas and handlers out of `SdkMcpToolDefinition` objects and prevents the two tool catalogs from drifting. Construct the ToolSet per acquired Run so every closure retains the existing fenced `{ userId, conversationId, runId, sandboxId }` binding. Although `HarnessAgent` is designed to be reusable, its `tools` are construction-time state and its current runtime context is not a per-call dependency injection channel; a per-Run agent definition is the simplest safe choice.

Three compatibility details need explicit tests:

1. **Names.** Existing Claude events are MCP-qualified as `mcp__mymemo-executor__Bash`; the Harness bridge internally exposes `mcp__harness-tools__Bash` but emits the short user-tool name `Bash` back to HarnessAgent. MyMemo's durable tool-event projection currently recognizes the old qualified prefix, so add a single canonical name mapping at the projection boundary rather than encoding MCP transport names into the new ToolSet keys.
2. **Results and errors.** Existing handlers return MCP `CallToolResult` envelopes (`content[]`, optional `isError`). An AI SDK tool `execute` should adapt that into the semantic output expected by the Harness relay and preserve error/repair behavior. Do not blindly return the MCP envelope or Claude will receive a JSON-encoded envelope inside another MCP result. Pin success, bounded error, and `PresentUI` repair cases with integration tests.
3. **Sandbox argument.** HarnessAgent invokes user tools on the host and supplies the caller-owned session as `experimental_sandbox`. The adapter wrapper must deliberately discard that argument. Add a regression test whose local session methods throw if called during any tool execution; only the E2B clients captured in `RunToolDefinition.execute` may observe prompt-derived input.

The active allowlist is then `Object.keys(toolSet)`. This replaces the current SDK-qualified `EXECUTOR_ALLOWED_TOOLS` only on the Harness path; the legacy path can keep its existing allowlist until removed.

## Runtime image and bootstrap gaps

This is the largest immediate implementation gap in the current repo.

MyMemo's production image uses `oven/bun:1-distroless`, runs as UID 65532, and has no general shell-oriented toolchain ([current Dockerfile](../../apps/agentcore-runtime/Dockerfile)). The Claude adapter cannot run unchanged in that image:

- both `@ai-sdk/harness` and `@ai-sdk/harness-claude-code` declare Node 22 or newer ([Harness package](https://github.com/vercel/ai/blob/main/packages/harness/package.json#L80-L82), [Claude adapter package](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/package.json#L55-L57));
- the bridge is launched with the literal `node .../bridge.mjs` command;
- first bootstrap writes the bridge assets, runs `pnpm install --frozen-lockfile`, then executes the installed Claude CLI version check ([Vercel Claude bootstrap source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-bootstrap.ts));
- adapter setup uses POSIX commands such as `mkdir -p` and shell quoting.

For a spike, use a non-distroless ARM64 image containing Node 22, `pnpm`, `/bin/sh`, and the minimal process/file utilities needed by the adapter. Run it as the existing non-root UID, make the selected working directory writable, and allow registry/model egress.

For production, prefer a build-time-pinned bridge dependency set instead of installing packages from the public registry on first customer traffic. Current upstream does not expose a supported “preinstalled bridge; skip bootstrap” mode; Vercel tracks that limitation in [issue #18609](https://github.com/vercel/ai/issues/18609). Until upstream supports it, the practical choices are:

1. keep the upstream runtime bootstrap, pin package versions/lockfile, use an internal registry/cache, and persist its output; or
2. maintain a small, well-tested adapter patch that accepts an immutable preinstalled bridge path.

Do not assume Bun's Node compatibility or a `node -> bun` symlink is sufficient. The bridge and Claude Agent SDK must be smoke-tested under the exact production image, architecture, UID, CA bundle, and network mode.

## Persistence, stop, and resume

AgentCore preserves the same filesystem and processes while a microVM is active, but idle timeout, maximum lifetime, explicit stop, or unhealthy compute replaces it. The logical Runtime session can wake on a new microVM using the same ID; only a configured session-storage mount survives ([AWS isolated sessions](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-sessions.html), [AWS lifecycle settings](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-lifecycle-settings.html)).

The Claude adapter stores important state below the sandbox's default working directory:

- `.harness-bootstrap/claude-code` for installed bridge assets and its bootstrap marker;
- `.agent-runs/<sessionId>/bridge` for replay/lifecycle state;
- the Harness session work directory.

It can attach to a still-running bridge after `detach()`/`suspendTurn()`. If the process is gone, it respawns: a continued in-flight turn may replay its disk event log, while a between-turn resume asks Claude to continue its on-disk thread ([Vercel lifecycle source](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L770-L791), [restart ladder](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L928-L1006)).

Required persistence design:

- Configure AgentCore managed session storage and set the local session's `defaultWorkingDirectory` to its mounted subdirectory, not `/tmp` or the image filesystem.
- Put Claude's effective `HOME` under the same mount, because Claude CLI thread history/config can otherwise remain in the ephemeral container home. Use a Conversation-specific directory and do not persist credentials there.
- Persist `resumeFrom`/`continueFrom` and the exact `sessionId` in MyMemo's Postgres Run state. Recreate a new local session wrapper on the next invocation and pass it back to `createSession`.
- Treat loopback bridge coordinates as an optimization only. A new microVM invalidates the old socket/process; disk replay or rerun must work.
- Implement process groups and reaping in `spawn().kill()`. `session.stop()`/`destroy()` stops the bridge but, because the basic sandbox is caller-owned, it correctly does not stop the whole AgentCore Runtime.

Managed session storage is currently Preview, limited, expires after 14 idle days, and is cleared on a Runtime version update. It also has filesystem feature gaps. EFS or S3 Files are alternatives but need tenant-path controls ([AWS filesystem configurations](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html), [AWS quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)). MyMemo's Postgres transcript mirror remains the durable product record; it is not automatically sufficient to reconstruct Claude's private native thread after local state loss. Define a clean “start new native Claude thread from product history/summary” fallback for storage expiry and deployments.

One fixed bridge port is acceptable because MyMemo documents concurrency one per AgentCore Runtime session. Enforce one live Claude bridge per Conversation session, kill stale owners before binding, and fail closed on an unexpected listener. If that concurrency invariant changes, introduce a port allocator and per-session process registry.

## Why a separate AgentCore sandbox Runtime is unnecessary here

A second low-privilege AgentCore Runtime per Harness session remains the correct design if Claude built-ins must execute, arbitrary untrusted MCP servers must run, or model-controlled local code becomes a requirement. It would restore a hard microVM boundary but require an AWS file/process control RPC plus a `/ws` bridge proxy because AgentCore exposes fixed `/invocations` and `/ws` application routes rather than arbitrary child ports ([AWS HTTP contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-http-protocol-contract.html), [AWS WebSocket contract](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-get-started-websocket.html)).

Under the narrowed scope, that second Runtime duplicates E2B without moving any model-directed work into it. It adds lifecycle, storage, auth, network, observability, and cost complexity for no new boundary. Keep E2B.

## PR #19108: `localWorkspace` can replace the custom local session

[PR #19108](https://github.com/vercel/ai/pull/19108) is open, stacked on #19107, and explicitly supersedes #18383. Its supported API is `workspace: localWorkspace({ path?, env? })`: `path` defaults to `process.cwd()`, is resolved and lazily created, and becomes the session work directory; `env` overlays the complete inherited host environment. The API rejects the filesystem root and home directory, but its source stresses that `path` selects where the harness works, not what it can reach. `workspace` and `sandbox` are mutually exclusive. If neither is set and `createSession` receives no caller-owned session, Harness creates an implicit current-directory workspace and warns once per process ([public API](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace.ts), [agent selection logic](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/agent/harness-agent.ts#L210-L424)). MyMemo should always configure an explicit workspace path.

The branch is a deep stack rather than a standalone patch: it includes open PRs #19099, #19100, #19102, and #19103 through #19108. Those prerequisites add graceful Claude interruption, bootstrap-on-resume, exact Claude conversation resume, `stateDirectory`, the history contract and Claude history reader, install consent, and use of the environment's own Claude executable. On 2026-08-26 the PR had no reviews and still required review. One latest Node 26 edge CI run was red in `kills the entire process tree on stop`; the corresponding Node suite passed, and the edge failure read an empty PID file because the test waits only for file existence before reading it, so it appears to be a test race rather than observed process-tree cleanup failure. It still makes the current branch unsuitable as a production dependency.

The earlier “no public provider” description needs precision: the public `LocalWorkspace` value deliberately hides its `provider` as `@internal`, but its lazy implementation **does implement `HarnessV1SandboxProvider`**. It allocates one free loopback port, creates a network session, separates Harness state from the project, implements resume by rebinding to the same durable directories, and lets `HarnessAgent` own stop/destroy. Consumers are expected to use `workspace`, not import or depend on `LocalWorkspaceProvider` ([provider source](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-provider.ts)). This is a higher-level alternative to merged [PR #19053](https://github.com/vercel/ai/pull/19053): #19053 remains the escape hatch for a caller-owned `sandboxSession`, while #19108 supplies and owns the local session internally.

Internally, the local session is exactly the compatibility layer proposed in this note, with several useful hardening details already implemented:

- File APIs and `bash -c` child processes run against the real host filesystem, accept absolute paths, inherit the host environment, and apply **no containment**. Children use detached process groups; abort, stop, destroy, and a process-exit reaper kill the group. The filesystem functions are captured before adapters can monkey-patch Node built-ins ([filesystem/process session](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-sandbox-session.ts)).
- The network session exposes `127.0.0.1` endpoints and intentionally omits `setNetworkPolicy` and `setPorts` because it cannot enforce either. Its allocated port is found by binding port zero and then closing the probe socket, so binding is not atomic, although one-Conversation-at-a-time makes the race small ([network session](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-network-sandbox-session.ts), [allocator](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-provider.ts#L182-L199)).
- Harness-owned state goes to `~/.ai-sdk/harness/projects/<basename>-<path-hash>/` with a project manifest, or beneath the process-level `AI_SDK_HARNESS_STATE_DIR`. That override is read from `process.env`; passing it only in `localWorkspace({ env })` does not relocate the store. Bootstrap is cached by identity with a marker file and in-process promise, but different host processes are not lock-coordinated ([state layout](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-state.ts), [bootstrap coordination](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-provider.ts#L111-L180)).

The forced complete environment inheritance is worth treating as a production constraint, not merely a convenience. `localWorkspace({ env })` can overlay values but cannot remove ambient AgentCore variables before bootstrap, bridge, and Claude child processes inherit them. MyMemo's current direct SDK path already supplies the trusted Runtime environment to Claude, so this is not a new regression, but it preserves that broad trusted-compute blast radius. If migration is also meant to narrow child-process credentials, the public workspace API is currently insufficient; use a caller-owned filtered session or request an upstream environment-filtering option.

For Claude Code, the bootstrap is written beneath that state directory and runs `pnpm install --frozen-lockfile --no-optional`; omitting optional dependencies avoids bundled CLI binaries, but the environment must still provide `node`, `pnpm`, `bash`, and a working `claude`. The bridge is launched as `node .../bridge.mjs --workdir <project> --bridge-state-dir <state>/.agent-runs/<sessionId>/bridge`. Because a local workspace declares `environmentOwner: 'user'`, a missing Claude executable is not installed by default; server-side MyMemo should bake and pin it rather than enable runtime global `npm install` ([Claude bootstrap](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness-claude-code/src/claude-code-bootstrap.ts), [bridge start](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness-claude-code/src/claude-code-harness.ts#L919-L1170), [executable resolution](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness-claude-code/src/resolve-claude-executable.ts)). This makes MyMemo's current Bun distroless image a hard blocker; adopting #19108 does not remove the image work described above.

Lifecycle is split between Harness and the runtime's durable stores. `detach()` keeps a live bridge attachable within the same AgentCore process; the exit reaper kills it when that process exits. On resume in a replacement process, the provider reopens the same project/state paths and the Claude adapter first tries the saved loopback coordinates, then respawns and uses disk replay or the Claude thread ID. `stop()` and `destroy()` reap bridge process trees but never delete the project or central state ([local resume](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness/src/workspace/local-workspace-provider.ts#L79-L109), [Claude recovery ladder](https://github.com/vercel/ai/blob/039f675c38e1ca33c1c9f1b25caa3719f4fa661f/packages/harness-claude-code/src/claude-code-harness.ts#L982-L1168)). The central Harness store does **not** contain Claude's native `~/.claude/projects/<workdir>` history. For AgentCore compute replacement, MyMemo must place all three of the explicit workspace, `AI_SDK_HARNESS_STATE_DIR`, and Claude's effective writable home on the per-Conversation persistent mount, while keeping credentials out of persisted home state.

For MyMemo, therefore, #19108 can replace both the proposed handwritten local basic session and any custom local `HarnessV1SandboxProvider` once the stacked work lands in a consumable release. Configure one explicit workspace per Conversation/AgentCore session and retain the Conversation UUID as Harness `sessionId`; let the internal provider allocate loopback and own bridge cleanup. It does **not** replace E2B and does not strengthen isolation. Continue to pass only E2B-backed host tools in `activeTools`, keep Claude native built-ins empty, and keep the regression test that fails if any host tool touches `experimental_sandbox`—under `localWorkspace`, that object has unrestricted host file/process authority. Until #19108 and its prerequisite stack merge, the caller-owned session from #19053 remains the stable implementation path; copying the internal provider would couple MyMemo to an open, changing API.

## Upstream issues and PRs

Status checked 2026-08-26 against the Vercel AI GitHub repository:

- The provider/session foundation is shipped: [PR #15919](https://github.com/vercel/ai/pull/15919) merged `HarnessV1NetworkSandboxSession`, `HarnessV1SandboxProvider`, and the initial Vercel/just-bash providers.
- Provider expansion remains open. The umbrella [issue #16100](https://github.com/vercel/ai/issues/16100) was split into eight open provider issues: [#17635 Sprites](https://github.com/vercel/ai/issues/17635), [#17636 E2B](https://github.com/vercel/ai/issues/17636), [#17637 Modal](https://github.com/vercel/ai/issues/17637), [#17638 Cloudflare](https://github.com/vercel/ai/issues/17638), [#17639 OpenSandbox](https://github.com/vercel/ai/issues/17639), [#17640 Tensorlake](https://github.com/vercel/ai/issues/17640), [#17641 Daytona](https://github.com/vercel/ai/issues/17641), and [#17642 Runloop](https://github.com/vercel/ai/issues/17642). The E2B issue specifically targets a first-party bridge-capable provider and a live WebSocket `101` verification. Two provider implementations are open: [PR #16265 Tensorlake](https://github.com/vercel/ai/pull/16265) and [PR #16270 Sprites](https://github.com/vercel/ai/pull/16270).
- The exact primitive proposed here is upstream: merged [PR #19053](https://github.com/vercel/ai/pull/19053) added `createSession({ sandboxSession })`, made the constructor's provider optional, and kept caller-supplied lifecycle caller-owned.
- Host-local work is still active. Open [PR #19108](https://github.com/vercel/ai/pull/19108) supersedes closed [PR #18383](https://github.com/vercel/ai/pull/18383); its supported surface is `workspace: localWorkspace(...)`, backed internally by a non-public `HarnessV1SandboxProvider`. If released, it can replace MyMemo's custom caller-owned local session; until then, #19053 is the shipped path.
- Native Claude SDK sandbox-option forwarding for host-based providers is still open as [issue #17085](https://github.com/vercel/ai/issues/17085) and [PR #17096](https://github.com/vercel/ai/pull/17096). It matters if Claude built-ins execute locally; MyMemo's all-built-ins-disabled design should not depend on it.
- The microVM bootstrap-cache problem reported in [issue #18210](https://github.com/vercel/ai/issues/18210) is fixed: merged [PR #18294](https://github.com/vercel/ai/pull/18294) moved relative adapter bootstrap state from `/tmp` under the sandbox default working directory. This supports the persistent-directory plan above.
- Repository searches found no AgentCore- or AWS-specific Harness sandbox provider issue/PR. Existing AgentCore hits concern the unrelated tools registry/docs, not `@ai-sdk/harness`; see the live GitHub [issue search](https://github.com/vercel/ai/issues?q=repo%3Avercel%2Fai+AgentCore+harness+sandbox) and [PR search](https://github.com/vercel/ai/pulls?q=repo%3Avercel%2Fai+AgentCore+harness+sandbox).

## Effort estimate

These are engineering estimates inferred from the current code and contracts.

| Deliverable | Estimate | Includes |
|---|---:|---|
| Host-driven custom `HarnessV1` proof of concept | **5–8 engineer-days** | Direct SDK wrapper, one text turn, one E2B host tool, V1 stream/usage mapping, stop/detach, and built-in invariant test. |
| Host-driven production integration | **3–5 engineer-weeks** | Full event translation, tool catalog migration, durable suspend/continue with pending results, structured-output policy, telemetry, security/load tests, and rollback. |
| Local-session proof of concept | **3–5 engineer-days** | Node-capable dev image, local file/process adapter, loopback bridge, all-built-ins-off test, one E2B tool, one turn and cleanup. |
| MyMemo integration spike | **1–2 engineer-weeks** | ARM64 image, Conversation mapping, E2B tool relay, Run streaming, resume payload persistence, forced bridge restart, basic metrics. |
| Production hardening | **3–6 engineer-weeks** | pinned/bootstrap strategy, managed-storage/deployment fallback, process registry/reaping, security regression suite, dependency/egress policy, load/failure tests, observability and rollback. |
| Separate AgentCore sandbox Runtime | **add 6–10+ engineer-weeks** | Only justified if untrusted execution moves out of E2B; includes control RPC, WebSocket proxy, IAM/network isolation, cleanup, and conformance tests. |

## Spike acceptance criteria

1. In a captured Claude SDK start, the native `tools` set is empty and all native tools are disallowed; only expected `mcp__harness-tools__*` calls can complete.
2. Attempts to elicit Bash, Read, WebFetch, Agent/subagent, Skill, worktree, or an unknown future built-in produce no local effect and fail the turn if emitted.
3. Every prompt-derived command/path is observed at the E2B client boundary, never at local `spawn` except adapter-owned bootstrap/bridge commands.
4. The bridge binds loopback only, requires its random token, and no non-loopback port is exposed.
5. A stopped bridge respawns from persisted state; a simulated fresh microVM restores the mounted directories and resumes or cleanly falls back to a new native thread.
6. Aborted turns, bootstrap failure, timeout, and handler shutdown leave no child/process-group or port owner behind.
7. The production ARM64/non-root image passes a live Claude tool call through E2B without writing model credentials into the persistent mount.

## Conclusion

For Claude-only with all native tools disabled, MyMemo should first spike a custom host-driven `HarnessV1` around its existing direct Claude SDK path. It is the only option here that is genuinely host-driven: E2B remains the supplied semantic workspace, custom Harness tools are relayed to Claude through in-process MCP, and no Claude bridge, local workspace provider, or network sandbox session is involved.

A caller-owned local `SandboxSession` remains a sensible compatibility layer for the alternative upstream `createClaudeCode` path and does not need to become an AgentCore sandbox provider. That bridge-backed design also preserves MyMemo's security model when every model-directed effect remains in E2B, but it carries more runtime/bootstrap/process machinery.

The claim is conditional, not absolute: the local Claude dependency chain shares the trusted AgentCore microVM and credentials. The design must enforce a custom-tool allowlist, treat any built-in execution as a fault, avoid native MCP servers, and keep tool implementations explicitly E2B-backed. With those controls, the remaining risks are conventional trusted-runtime supply chain, image/bootstrap, and persistence risks—not prompt-injectable local shell access.
