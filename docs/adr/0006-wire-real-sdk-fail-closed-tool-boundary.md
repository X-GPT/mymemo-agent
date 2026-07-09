# Wire the real Claude Agent SDK behind a fail-closed tool boundary

Status: accepted

Milestone 7 built the SDK run loop behind the `RunProcessor` seam
(`agent-stream.ts`, `run-tools.ts`, `session-store.ts`) but left `index.ts`
wiring the synthetic processor and `startRunQuery` unimplemented. This decision
records how the real query is configured when we replace the synthetic
processor with `createSdkRunProcessor(startRunQuery)`.

The SDK's `query()` spawns the Claude Code runtime **as a subprocess in the
trusted Fargate worker**. That subprocess ships built-in `Bash`/`Read`/`Write`/
`Edit`/`Grep`/`Glob` tools that execute against the **Fargate** filesystem —
which would violate the split-runtime constraint (no model-controlled shell or
file access in Fargate) and bypass every path/byte bound and the E2B isolation.
So the query is configured so the model can reach **only** our in-process MCP
executor tools (`mcp__mymemo-executor__*`), which route to E2B:

- `tools: []` — disable all built-in tools; `mcpServers` is a separate channel
  and is unaffected.
- `settingSources: []` — the subprocess loads no Fargate-side `CLAUDE.md`/
  settings.
- `permissionMode: 'dontAsk'` + `allowedTools` naming exactly our MCP tools —
  there is no human to answer a permission prompt, so an unexpected tool must be
  **denied**, never left to hang, and never bypassed.
- A static, minimal MyMemo system prompt (a plain string, no `claude_code`
  preset): the tool surface is bespoke, and the preset assumes native tools we
  disabled. It states the role, that the executor tools act on the E2B workspace
  (`/home/user`), and that `SearchDocuments`/`LoadDocuments` reach the scoped KB.
- OpenRouter via `env` + `model` from `buildModelClientConfig` (ADR-0003), the
  provisioned run's tools as `mcpServers`, the linked `abortController`, and the
  user message (read from the run's `run_started` event) as the prompt.

Real model execution against a pinned external dependency in our exact runtime
is not proven by documentation. A throwaway `spikes/sdk-runtime/` spike (same
lifecycle as the Task 4.1 E2B spike) gates this work: it proves `query()` spawns
under `executable: 'bun'` and completes a turn against OpenRouter, that
`Options.env` merges rather than replaces the subprocess env, that the CLI
resolves after `bun install --production`, that the MCP tools are callable with
nothing prompting, that `interrupt()` halts a query, and that the `result`/
`mirror_error` message shapes and `SessionStore` resume that `agent-stream.ts`
and `session-store.ts` already assume are real. Findings finalize the
`executable` choice and fold back into the plan before the wiring is built.

## Considered Options

- **`tools: []` + fail-closed allowlist (`dontAsk` + `allowedTools`)** (chosen) —
  two independent guards: built-ins are gone, and even if one reappeared it is
  denied, not executed in Fargate.
- **`bypassPermissions`** — rejected: leans entirely on `tools: []` being the
  only guard; auto-runs any tool. One guard where the codebase's ethos (exposure
  gate, projector) is fail-closed.
- **`claude_code` preset (± append)** for the system prompt — rejected: the
  preset describes the native tools we disabled and injects working-directory/
  git/auto-memory sections computed from the Fargate projectKey anchor, not the
  E2B workspace — actively misleading. A static custom string is also cacheable
  across conversations.
- **Assume the SDK behaves as documented** (no spike) — rejected: the Task 4.1
  spike found the design's guessed E2B option shape was wrong and forced an
  entire module (`bash-wrapper.ts`); the SDK subprocess carries the same risk.

## Consequences

- The client-visible tool surface is exactly the eight `mcp__mymemo-executor__*`
  tools; the SDK subprocess in Fargate executes no model-controlled shell or
  file operation.
- The spike is task #1 and may flip `executable: 'bun'` to `'node'` (adding a
  runtime to the image). Nothing downstream is built until it passes.
- A durable smoke test (real `query()` against OpenRouter + E2B, run against the
  built image) becomes the regression guard the spike's one-time proof hands off
  to; the in-image run is what catches the `--production` prune/`PATH` trap.
- On a failed turn the client `error` frame carries a **generic** message; the
  full error is logged worker-side. Wiring the real SDK is what first fills the
  failure with uncontrolled provider/E2B/exception text, which must not reach the
  client.
