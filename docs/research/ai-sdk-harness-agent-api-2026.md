# AI SDK `HarnessAgent` API

**Research date: 2026-08-26.** This note reflects `@ai-sdk/harness` **1.0.87** and
the corresponding Vercel AI SDK `main` source. The package is experimental, so
minor releases can change this surface. Sources are limited to Vercel's official
documentation and repository.

## Short answer

`HarnessAgent` is AI SDK 7's wrapper for running established agent runtimes such
as Claude Code, Codex, Deep Agents, OpenCode, and Pi through the standard AI SDK
`Agent` interface. It is published by Vercel in `@ai-sdk/harness` and imported
from the `/agent` subpath:

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent';
```

The package manifest identifies version 1.0.87 and maps `./agent` to its own
JavaScript and declaration entry points
([package manifest](https://github.com/vercel/ai/blob/main/packages/harness/package.json)).
Vercel describes the abstraction as a common interface over external harnesses,
with AI SDK-compatible generation and streaming results
([AI SDK 7 announcement](https://vercel.com/changelog/ai-sdk-7),
[harness architecture](https://github.com/vercel/ai/blob/main/architecture/harness-abstraction.md)).

## `HarnessAgent` public properties

| Property | Type | Purpose |
| --- | --- | --- |
| `version` | `'agent-v1'` | AI SDK `Agent` interface version used for compatibility. |
| `id` | `string \| undefined` | Optional stable ID supplied in the constructor. |
| `tools` | merged `ToolSet` | Adapter built-in tools plus user tools. A user tool wins if its name collides with a built-in. |
| `harnessId` | `string` getter | Identifier of the configured underlying harness adapter. |

These are the only public instance properties/getters declared by the class
([`HarnessAgent` source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L119-L203)).

## `HarnessAgent` public methods

| Method | Purpose |
| --- | --- |
| `createSession(options?)` | Creates a new sandbox/runtime session or restores one. Returns a `HarnessAgentSession`, which must be supplied to turn methods. |
| `generate(options)` | Runs a prompted turn and waits for completion, returning an AI SDK `GenerateTextResult`. |
| `stream(options)` | Starts a prompted turn and returns an AI SDK `StreamTextResult` for incremental consumption. |
| `continueGenerate(options)` | Continues an unfinished turn **without a new prompt**, waits for it, and returns a complete result. |
| `continueStream(options)` | Streaming equivalent of `continueGenerate()`. |
| `experimental_steer(options)` | Submits another user message to a currently running turn for the runtime's next safe input boundary. The resulting output stays in the current stream; the adapter must support steering. |

The complete signatures and behavior are in the
[`HarnessAgent` implementation](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L204-L592).
Steering was added in 1.0.78 and remains explicitly experimental
([changelog](https://github.com/vercel/ai/blob/main/packages/harness/CHANGELOG.md#L268-L272)).

### `createSession()` options

```ts
await agent.createSession({
  sessionId?,       // generated when omitted
  resumeFrom?,      // state from session.detach() or session.stop()
  continueFrom?,    // state from session.suspendTurn()
  sandboxSession?,  // caller-owned existing sandbox
  abortSignal?,
});
```

`resumeFrom` and `continueFrom` are mutually exclusive. For cross-process
restoration, reuse the original `sessionId`. If `sandboxSession` is supplied,
the caller retains its lifecycle; otherwise the configured sandbox provider
creates or resumes it
([source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L204-L458)).

### Turn method inputs and results

`generate()` and `stream()` take the normal AI SDK Agent call/stream parameters
plus a required `session`. A prompt may be a string or model messages. With a
message array, `HarnessAgent` uses pending approval/tool-result continuations
when present; otherwise it forwards the last user message rather than replaying
the full history, because the harness session owns prior-turn state
([source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L459-L510),
[input projection](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L654-L703)).

`continueGenerate()` and `continueStream()` accept:

```ts
{
  session,
  toolApprovalContinuations?,
  toolResultContinuations?,
  abortSignal?,
}
```

They are for an already-started, unfinished turn restored with `continueFrom`;
they do not send another prompt
([source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L512-L579)).

## Constructor settings

```ts
new HarnessAgent({
  harness,           // required adapter
  id?,
  tools?,
  skills?,
  instructions?,
  output?,           // typed/schema-backed output for every turn
  stopWhen?,
  permissionMode?,   // defaults to 'allow-all'
  toolApproval?,
  sandbox?,          // optional if every createSession supplies sandboxSession
  sandboxConfig?: {
    workDir?,
    bootstrapHash?,
    onBootstrap?,
    onSession?,
  },
  activeTools?,       // mutually exclusive with inactiveTools
  inactiveTools?,
  telemetry?,
  debug?,
  onLog?,
  onSandboxSession?,  // deprecated; use sandboxConfig.onSession
});
```

The authoritative descriptions and generic types are in
[`HarnessAgentSettings`](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-settings.ts#L28-L199).
Structured output via `output` was added in 1.0.73
([changelog](https://github.com/vercel/ai/blob/main/packages/harness/CHANGELOG.md#L305-L309)).

## Returned `HarnessAgentSession` surface

Most lifecycle operations deliberately live on the session rather than the
stateless agent definition:

| Member | Purpose |
| --- | --- |
| `sessionId` | Stable session identifier used when restoring state. |
| `isResume` | Whether this handle was created from resume/continuation state. |
| `hasUnfinishedTurn()` | Reports whether the session has a non-idle turn. |
| `compact(customInstructions?)` | Asks a supporting runtime to compact its context. Unsupported adapters throw `HarnessCapabilityUnsupportedError`. |
| `experimental_steerTurn(text)` | Session-level implementation used by `agent.experimental_steer()`. |
| `detach()` | Returns resumable state and invalidates the local handle while leaving the runtime/sandbox running. |
| `stop()` | Returns resumable state, then stops the runtime and any harness-owned sandbox. |
| `destroy()` | Cleans up without keeping resume state. |
| `suspendTurn()` | Freezes an unfinished turn and returns serializable continuation state, leaving the runtime/sandbox running. |

See the official
[`HarnessAgentSession` source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts#L57-L167)
and its
[consumer lifecycle methods](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts#L329-L492).
`getSandboxSession()`, `getSessionWorkDir()`, `promptTurn()`, and `continueTurn()`
are technically methods on the exported class, but the source documents or uses
them as framework plumbing rather than the normal consumer API.

## Other value exports from `@ai-sdk/harness/agent`

The `/agent` module also exports:

- `HarnessAgentSession`, `HarnessError`,
  `HarnessCapabilityUnsupportedError`, and
  `HarnessSandboxAuthenticationError`.
- `collectHarnessAgentToolApprovalContinuations()` and
  `collectHarnessAgentToolResultContinuations()` for recovering client-submitted
  approval decisions and tool results from AI SDK message history.
- `prepareHarnessSandboxTemplate()` for prewarming a provider-managed reusable
  sandbox template; `prewarmHarness` is its deprecated alias.
- `prepareSandboxForHarness()` for applying one or more harness bootstrap
  recipes to a caller-owned sandbox before the caller snapshots or persists it.
- `getHarnessErrorMessage()` for producing the public-facing message from a
  harness error.
- `createFileReporter()` and `createTraceTreeReporter()` for harness diagnostics.

The exact value and type exports are listed in the official
[`/agent` barrel](https://github.com/vercel/ai/blob/main/packages/harness/agent/index.ts).
The continuation helpers' transformations are documented in their
[approval source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-tool-approval-continuation.ts)
and
[tool-result source](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-tool-result-continuation.ts).
The sandbox preparation semantics are documented in
[`prepareHarnessSandboxTemplate`](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/prepare-harness-sandbox-template.ts)
and
[`prepareSandboxForHarness`](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/prepare-sandbox-for-harness.ts).

## Minimal lifecycle

```ts
const agent = new HarnessAgent({ harness, sandbox });
const session = await agent.createSession();

try {
  const result = await agent.generate({ session, prompt: 'Inspect the repo.' });
  console.log(result.text);
} finally {
  await session.destroy();
}
```

There is no `respond()` method on `HarnessAgent`. Its direct turn APIs are
`generate()` and `stream()`, plus the continuation and experimental steering
methods above.
