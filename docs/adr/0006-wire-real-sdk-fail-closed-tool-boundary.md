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
- OpenRouter via `env` + `model` from `buildModelClientConfig` (ADR-0003) —
  with the model-client vars spread **over `process.env`**, because `Options.env`
  replaces the subprocess env (spike s2) — the provisioned run's tools as
  `mcpServers`, the linked `abortController`, the boot-verified
  `pathToClaudeCodeExecutable` (spike s3), and the user message (read from the
  run's `run_started` event) as a **plain string** prompt (spike s5).

Real model execution against a pinned external dependency in our exact runtime
is not proven by documentation. A throwaway `spikes/sdk-runtime/` spike (same
lifecycle as the Task 4.1 E2B spike) gated this work; it ran 2026-07-09 against
real OpenRouter and the built worker image (per-proof verdicts in plan Task
9.1). The boundary held exactly as designed: the `system/init` tool list
contained only the MCP executor tools, the allowlisted tool executed, an
unlisted tool was auto-denied without prompting or hanging (visible in
`result.permission_denials`), and the `result`/`mirror_error` shapes and
`SessionStore` resume that `agent-stream.ts` and `session-store.ts` assume are
all real. Three findings amend the wiring and are binding on it:

- **The CLI is a native platform binary; `executable: 'bun' | 'node'` is
  inert.** The SDK spawns `@anthropic-ai/claude-agent-sdk-{platform}-{arch}
  [-musl]/claude` (its optional platform packages — no `cli.js` exists in
  0.2.117), so no JS runtime runs the CLI and the bun-vs-node question
  dissolves. But on linux the SDK tries **musl before glibc**, `bun install
  --production` puts both variants in the Debian-based image, and the musl
  binary cannot exec on glibc — so default resolution **fails inside the built
  image**. The worker must pin `pathToClaudeCodeExecutable` to the glibc
  platform binary — resolved from the SDK package's own module context
  (`require.resolve(..., { paths: [sdkDir] })`; the platform packages are the
  SDK's optional deps, not ours) — and verify it once at boot, fail-fast. A
  live in-image turn passed with the pinned path.
- **`Options.env` replaces the subprocess env, it does not merge.** A query
  env of one canary var reached the CLI as exactly that var (plus an injected
  `CLAUDE_CODE_ENTRYPOINT`) — no `PATH`, no `HOME`. The query env is therefore
  `{ ...process.env, ...buildModelClientConfig(...).env }` plus an ephemeral
  `CLAUDE_CONFIG_DIR` for the CLI's local transcript copy (the `sessionStore`
  mirror is a dual-write; the local copy still gets written).
- **The prompt must be a plain string (or an input stream that completes) —
  never held open.** `interrupt()` halts a string-prompt turn and the stream
  self-terminates in ~3 s, ending with an `is_error` result whose text is
  internal diagnostics and a thrown stream error — which `RunLoop.finish`
  already remaps to `canceled` (cancellation wins over failure). With a
  held-open streaming input, generation halts but the stream **never ends**
  and the consuming worker would hang until stale-run recovery.

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
- The spike ran and passed with the three amendments above. No runtime is added
  to the image; the `executable` question is retired. The image instead ships
  the SDK's glibc linux platform package and the worker pins + boot-verifies
  `pathToClaudeCodeExecutable` to it.
- A durable smoke test (real `query()` against OpenRouter + E2B, run against the
  built image) becomes the regression guard the spike's one-time proof hands off
  to; the in-image run is what catches the platform-binary resolution trap
  (musl-first) and any `--production` prune regression.
- On a failed turn the client `error` frame carries a **generic** message; the
  full error is logged worker-side. Wiring the real SDK is what first fills the
  failure with uncontrolled provider/E2B/exception text, which must not reach the
  client.
