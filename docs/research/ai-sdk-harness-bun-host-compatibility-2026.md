# AI SDK Harness host packages under Bun (chat-api)

**Research date: 2026-08-26.** This note answers
[issue #586](https://github.com/X-GPT/mymemo-agent/issues/586): can `@ai-sdk/harness`
and `@ai-sdk/harness-claude-code` run inside the chat-api process under **Bun**, given
both declare `engines.node >= 22`? Scope is the **host side only**: the process that
constructs `HarnessAgent`, talks to the Vercel Sandbox API, and holds the WebSocket to
the bridge. The bridge and the Claude CLI run inside the Vercel Sandbox and are out of
scope. Versions checked: `@ai-sdk/harness` 1.0.91, `@ai-sdk/harness-claude-code`
1.0.94, `@ai-sdk/sandbox-vercel` 1.0.91, `@vercel/sandbox` 3.1.0, `ai` 7.0.83,
Bun 1.3.0, Node 24.19.0 (macOS x86_64). Companion notes:
[`HarnessAgent` API](ai-sdk-harness-agent-api-2026.md) and
[Claude Harness inside AgentCore](ai-sdk-harness-agentcore-sandbox-feasibility-2026.md);
the latter's warning against relying on Bun's Node compatibility is about running the
**bridge** inside MyMemo's Bun image, which this note does not contradict.

## Short answer

**Yes, with high confidence, and there is no Node-only host dependency.** Concretely:

- The `>= 22` engines field is the only Node-specific claim. Vercel's own code path is
  explicitly Bun-aware: merged PR
  [vercel/ai#16069 "make listening for sandbox bridge readiness compatible with Bun"](https://github.com/vercel/ai/pull/16069)
  (merged 2026-06-12) exists because Bun hosts were already in use. Bun does not enforce
  `engines` at install or run time.
- Every Node built-in the host side imports (`crypto`, `fs`, `fs/promises`, `path`, `os`,
  `url`, `child_process`, `stream`, `zlib`, `timers/promises`) is listed as fully
  implemented by Bun, with caveats that do not touch the used surface.
- The WebSocket client to the bridge is the npm `ws` package. Bun replaces `ws` with a
  built-in shim; the four calls the adapter makes (`new WebSocket(url, { headers })`,
  `on`/`off` for `open|message|close|error`, `terminate()`) all work, verified with a
  loopback round-trip under Bun 1.3.0.
- `@vercel/sandbox` passes an `undici` `Agent({ bodyTimeout: 0 })` as `dispatcher`; Bun
  substitutes its own inert `undici` shim and its `fetch` ignores `dispatcher`, so the
  call succeeds, and the intent (no body-idle timeout on long log streams) is preserved
  because Bun's `fetch` has no default timeout.
- `ai` 7's `toUIMessageStreamResponse()` returns a standard `Response`; through Hono on
  `Bun.serve` it streamed 7 SSE chunks at the model's 200 ms cadence with no buffering.
- `import { HarnessAgent } from "@ai-sdk/harness/agent"` and `createClaudeCode()` load
  and construct under Bun with zero errors.

Not verified: a live bridge connection (needs Vercel Sandbox credentials) and the exact
Bun version in the floating `oven/bun:1` image. Both belong in the adoption spike's smoke
test, not in this note.

**Fallback if Bun ever blocks:** keep Bun for install and tests, add a
`bun build --target=node` stage, run the bundle on a `node:22` image behind
`@hono/node-server`. The bundle already boots under Node 24 with a two-line shim; the
real code change is three `Bun.env` reads and one `serve()` call. Roughly a day.

## What the `engines` field actually says

- `@ai-sdk/harness` 1.0.91: `"engines": { "node": ">=22" }`; `ws ^8.21.0` is an
  **optional** peer dependency
  ([package.json](https://github.com/vercel/ai/blob/main/packages/harness/package.json)).
- `@ai-sdk/harness-claude-code` 1.0.94: `"engines": { "node": ">=22" }`; `ws ^8.21.0`
  is a **hard** dependency
  ([package.json](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/package.json)).
- `@ai-sdk/sandbox-vercel` 1.0.91 also declares `node >= 22`; `@vercel/sandbox` 3.1.0
  declares no engines (local `jq` over the installed manifests, output below).
- Vercel's docs state "Node.js 22 or later" as a prerequisite
  ([KB guide](https://vercel.com/kb/guide/sandboxed-coding-agent-with-harnessagent)),
  and the `HarnessAgent` docs' `runtime: 'node24'` refers to the **sandbox** image, not
  the host ([HarnessAgent docs](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)).
  Neither the [harness overview](https://ai-sdk.dev/docs/ai-sdk-harnesses/overview) nor
  the [Claude Code adapter page](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code)
  says anything for or against Bun; the adapter page only requires "a network sandbox
  with at least one exposed port, e.g. `@ai-sdk/sandbox-vercel`".
- Bun ignores `engines`: `bun add` installed all three packages silently (output below),
  and the open Bun issue
  [oven-sh/bun#14030](https://github.com/oven-sh/bun/issues/14030) asks for
  `engineStrict` precisely because Bun currently does not check it.

The strongest primary signal is upstream itself. PR
[#16069](https://github.com/vercel/ai/pull/16069) describes the bug as "Bun can miss
`stdout` from detached sandbox bridge processes that bind an exposed port, so Claude
Code/Codex startup timed out waiting for `bridge-ready`", and the fix as "a shared
harness readiness helper that keeps `stdout` as the primary signal, falls back to the
bridge metadata file, and marks startup state". That helper ships today as
`waitForBridgeReady` in `@ai-sdk/harness/dist/utils/index.js`, which races the
sandbox process's stdout against a poll of the bridge metadata file (local read of
`src/utils/bridge-ready.ts` in the installed dist). It is part of the Vercel Sandbox
path, so chat-api gets it for free.

## Host-side Node API surface and Bun coverage

Imports were enumerated from the installed dists with
`grep -ohE '(from|require\()\s*"[^./][^"]*"' node_modules/<pkg>/dist/**/*.js | sort | uniq -c`.
Bun statuses are quoted from
[Bun's Node.js APIs page](https://bun.com/docs/runtime/nodejs-apis) ("reflects the
latest version of Bun's compatibility with Node.js v26").

| Module | Used by (host) | Bun status |
| --- | --- | --- |
| `crypto` (`randomBytes`) | harness, adapter | Partially implemented; missing `encapsulate`/`decapsulate` and some key/cipher types, none used |
| `fs`, `fs/promises` | harness, adapter, `@vercel/sandbox` | "Fully implemented. 98% of Node.js's test suite passes." |
| `path`, `os`, `url` | harness, adapter, `@vercel/sandbox` | "Fully implemented." |
| `child_process` (`execFileSync`) | adapter only, see below | Implemented; caveats are IPC handle passing and `subprocess.channel.ref()`, not used |
| `stream`, `stream/promises` | `@vercel/sandbox` | "Fully implemented." |
| `zlib` | `@vercel/sandbox` | "Fully implemented. 98% of Node.js's test suite passes." |
| `node:timers/promises` | `@vercel/sandbox` | Not on the page's caveat list; used only for `setTimeout` delays |
| `ws` | adapter (bridge WebSocket client) | Replaced by Bun's built-in shim, see next section |
| `undici` (`Agent`) | `@vercel/sandbox` | Replaced by Bun's built-in shim, see below |
| `fetch` (global) | `@vercel/sandbox` API client | "Fully implemented. The `integrity` option is ignored." |

`@ai-sdk/harness` itself imports only `crypto`, `fs`, `path` plus `ai`,
`@ai-sdk/provider`, `@ai-sdk/provider-utils`, `zod/v4`. The Claude adapter's single
`child_process` use is
`execFileSync("sh", ["-c", command])` to run the `apiKeyHelper` from `~/.claude/settings.json`
when present (adapter dist around line 224); it never spawns the bridge locally in the
Vercel Sandbox configuration, where `spawn` goes through `sandboxSession.spawn()` (the
HTTP sandbox API). Third-party pure-JS deps of `@vercel/sandbox` (`jose`, `tar-stream`,
`jsonlines`, `async-retry`, `lru-cache`, `@vercel/oidc`, `@workflow/serde`) rely on the
modules above.

## The WebSocket client: `ws` under Bun

What the adapter calls (grep over `@ai-sdk/harness-claude-code/dist/index.js`):

```js
import { WebSocket } from "ws";                       // line 32
const ws = new WebSocket(endpoint.url, {              // line 1261
  headers: endpoint.headers == null ? void 0 : { ...endpoint.headers }
});
ws.on("open"|"message"|"close"|"error", ...)          // 4 × ws.on, 4 × ws.off
ws.terminate();                                       // on failure
bridgeUrl.searchParams.set("agent_bridge_token", token);
```

No `handshakeTimeout`, `perMessageDeflate`, `ping`, `Sender`/`Receiver`, or
`createWebSocketStream`; the adapter runs its own open/hello timers.

Bun does not load the installed `ws` package at all. Its runtime hardcodes a module named
`ws` whose header reads "Hardcoded module "ws" / Mocking https://github.com/websockets/ws
/ this just wraps WebSocket to look like an EventEmitter"
([oven-sh/bun `src/js/thirdparty/ws.js`](https://github.com/oven-sh/bun/blob/main/src/js/thirdparty/ws.js)).
That shim implements `headers`, `perMessageDeflate`, `rejectUnauthorized`, `on`, `send`,
`close`, `terminate`, `ping`; only `Sender`, `Receiver`, and `createWebSocketStream`
throw "Not supported yet in Bun", and `handshakeTimeout` is not handled. Bun's client
`WebSocket` supports `ws://` and `wss://` and custom constructor headers as "a
Bun-specific extension of the `WebSocket` standard"
([Bun WebSocket docs](https://bun.com/docs/api/websockets)).

Local proof that the shim is what resolves, and that the adapter's call pattern works
(`ws-resolve.ts`, `ws-roundtrip.ts` in a scratch directory outside the repo; the
round-trip connects to a loopback `Bun.serve` WebSocket server that rejects the upgrade
unless both the custom header and the `agent_bridge_token` query parameter are present):

```text
$ bun run ws-resolve.ts
runtime bun 1.3.0
require.resolve('ws'): ws
Bun.resolveSync('ws'): ws
ws package.json version on disk: 8.21.3
ctor name: WebSocket | on(): function | terminate(): function | ping(): function | once(): function
=== globalThis.WebSocket: false | extends global WebSocket: false
WebSocketServer exported: function

$ bun run ws-roundtrip.ts
runtime bun 1.3.0 | readyState after open: 1
received: [ "{\"type\":\"bridge-hello\"}", "{\"type\":\"echo\",\"got\":\"{\\\"type\\\":\\\"prompt\\\",\\\"text\\\":\\\"hi\\\"}\"}" ]
close event after terminate(): { code: 1006 } | readyState: 3
OK
```

`require.resolve("ws")` returning the bare string `ws` instead of a filesystem path is the
builtin override; the on-disk 8.21.3 copy is inert.

## `undici` `Agent` in `@vercel/sandbox`

`@vercel/sandbox/dist/api-client/base-client.js` does
`const DEFAULT_AGENT = new Agent({ bodyTimeout: 0 })` and passes `dispatcher: this.agent`
to `globalThis.fetch` on every API call. Under Bun, `undici` is also a hardcoded module
([oven-sh/bun `src/js/thirdparty/undici.js`](https://github.com/oven-sh/bun/blob/main/src/js/thirdparty/undici.js))
whose `Agent extends Dispatcher {}` is an empty `EventEmitter` subclass, and Bun's native
`fetch` documents no `dispatcher` option and ignored it in the check below
(`undici-check.ts`):

```text
$ bun run undici-check.ts
runtime bun 1.3.0
require.resolve('undici'): undici | Bun.resolveSync: undici
undici version on disk: 7.29.0 | @vercel/sandbox 3.1.0 | @ai-sdk/sandbox-vercel 1.0.91
@ai-sdk/sandbox-vercel exports: [ "VercelSandboxProvider", "createVercelSandbox" ]
Agent constructed; own keys: [ "_events", "_eventsCount", "_maxListeners" ] | proto methods: [ "constructor" ]
global fetch with { dispatcher }: 200 pong
undici fetch with { dispatcher }: 200 pong
```

The `bodyTimeout: 0` exists to disable undici's default body-idle timeout on long-lived
sandbox log streams. Bun's `fetch` documents no default timeout at all ("To fetch a URL
with a timeout, use `AbortSignal.timeout`") and streams bodies as `ReadableStream`
([Bun fetch docs](https://bun.com/docs/api/fetch)), so the intent survives the shim.

## Streaming `toUIMessageStreamResponse()` through Hono on Bun

chat-api is served by Bun's fetch-handler convention (`export default productionApp` in
[`apps/chat-api/src/index.ts`](../../apps/chat-api/src/index.ts)), which is the documented
way to run Hono on Bun ([Hono on Bun](https://hono.dev/docs/getting-started/bun)), and it
already streams SSE in production via `streamSSE` in
[`conversations.route.ts`](../../apps/chat-api/src/features/conversations/conversations.route.ts).
`streamText().toUIMessageStreamResponse()` is typed as
`(options?: ResponseInit & UIMessageStreamOptions) => Response`
([streamText reference](https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text)); the AI
SDK's own Hono cookbook uses `@hono/node-server` but returns the same `Response`
([Hono cookbook](https://ai-sdk.dev/cookbook/api-servers/hono)).

Credential-free check with `MockLanguageModelV3` from `ai/test` emitting one chunk every
200 ms, served by Hono on `Bun.serve` and read back with `fetch` (`hono-stream.ts`):

```text
$ bun run hono-stream.ts
runtime bun 1.3.0 | hono 4.13.5 | ai 7.0.83
status 200 | content-type: text/event-stream | x-vercel-ai-ui-message-stream: v1 | transfer-encoding: chunked
+  32ms chunk#1: "data: {\"type\":\"start\"}\n\n"
+ 235ms chunk#2: "data: {\"type\":\"start-step\"}\n\ndata: {\"type\":\"text-start\",\"id\":\"t\"}\n\n"
+ 435ms chunk#3: "data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"one \"}\n\n"
+ 635ms chunk#4: "data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"two \"}\n\n"
+ 838ms chunk#5: "data: {\"type\":\"text-delta\",\"id\":\"t\",\"delta\":\"three\"}\n\n"
+1037ms chunk#6: "data: {\"type\":\"text-end\",\"id\":\"t\"}\n\n"
+1243ms chunk#7: "data: {\"type\":\"finish-step\"}\n\ndata: {\"type\":\"finish\",\"finishReason\":\"stop\"}\n\ndata: ...
chunks received: 7 | total ms: 1244
```

Chunks arrive at the producer's cadence, so nothing in Hono or `Bun.serve` buffers the
body. (chat-api's lockfile pins `hono` 4.12.12; the scratch check used 4.13.5.)

## Local import check

```text
$ mkdir <scratch> && cd <scratch> && printf '{"name":"harness-bun-check","private":true,"type":"module"}\n' > package.json
$ bun add @ai-sdk/harness @ai-sdk/harness-claude-code ai
bun add v1.3.0 (b0a6feca)
installed @ai-sdk/harness@1.0.91
installed @ai-sdk/harness-claude-code@1.0.94
installed ai@7.0.83
14 packages installed [429.00ms]

$ bun run import-check.ts
runtime bun 1.3.0
@ai-sdk/harness 1.0.91
@ai-sdk/harness-claude-code 1.0.94
ai 7.0.83
ws 8.21.3
HarnessAgent: function createClaudeCode: function streamText: function
harness.id: undefined harness.version: undefined
agent.harnessId: claude-code agent.version: agent-v1
exit=0
```

`import-check.ts` imports `HarnessAgent` from `@ai-sdk/harness/agent`, calls
`createClaudeCode({ port: 43127, portEndpoint: { url: "ws://127.0.0.1:43127" } })`, and
constructs `new HarnessAgent({ harness, activeTools: [] })`. No session is created, so
nothing needs credentials. The scratch directory lives outside the repo; the repo's
`package.json` and `bun.lock` were not touched.

## Fallback: a plain Node container for chat-api

If Bun ever blocks, the fallback is **not** `node src/index.ts`:

- chat-api and its workspace deps use extensionless relative imports (148 in runtime
  code, 0 with `.ts`), and `@mymemo/agent-db` / `@mymemo/live-text` export `.ts` sources
  directly. Node's type stripping (default since v22.18.0) requires explicit extensions
  and "refuses to handle TypeScript files inside folders under a `node_modules` path"
  ([Node TypeScript docs](https://nodejs.org/api/typescript.html)).

The lazy, verified path is to bundle with Bun and run with Node:

```text
$ bun install --frozen-lockfile   # in the worktree; node_modules is gitignored
$ bun build apps/chat-api/src/index.ts --target=node --outdir=apps/chat-api/.node-bundle \
    --external @statsig/statsig-node-core --external pg-native --external @electric-sql/pglite \
    --external pino --external hono-pino
Bundled 929 modules in 162ms
  index.js  3.0 MB  (entry point)

$ grep -n 'Bun\.' apps/chat-api/.node-bundle/index.js
77395:  const version3 = typeof Bun !== "undefined" ? Bun.version : undefined;
87673:var productionConfig = loadApiConfigFromEnv(Bun.env);

$ AGENT_DATABASE_URL=postgresql://x:y@127.0.0.1:1/db ARTIFACT_BUCKET=dummy AWS_REGION=us-east-1 \
  STATSIG_SERVER_SECRET=secret-dummy REDIS_URL=redis://127.0.0.1:6379 \
  LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS=true LOG_LEVEL=warn \
  node --import ./bun-shim.mjs apps/chat-api/.node-bundle/index.js
... [Statsig 401 warnings for the dummy key] ...
BOOT_OK: module graph loaded and app constructed under v24.19.0 - still alive after 8s
```

`bun-shim.mjs` is `globalThis.Bun = { env: process.env }` plus an 8 s timer that prints
`BOOT_OK`; the dummy Statsig key produced 401s but no real credential was used. The bundle
was deleted from the worktree afterwards. What a real fallback needs:

1. Replace the three `Bun.env` reads (`src/index.ts`, `src/db/migrate.ts`,
   `local/index.ts`) with `process.env`; the other `Bun.*` hits are test-only
   (`Bun.gc` in `agent-db/src/testing.ts`, `bun:test` in a `.contract.ts`).
2. Add a Node entry that calls `serve({ fetch: app.fetch, port })` from
   `@hono/node-server` ([Hono on Node.js](https://hono.dev/docs/getting-started/nodejs));
   `export default app` only serves under Bun. `@hono/node-server` 1.19.13 is already in
   `bun.lock` (transitively) but must become a direct dependency.
3. Add a Dockerfile stage `FROM node:22-bookworm-slim` that copies `node_modules` and
   the bundle from the existing `oven/bun:1` install stage; keep `bun install`,
   `bun test`, and the compose `local` target's install flow unchanged. Give
   `package.json` `"type": "module"` or emit `.mjs` to silence Node's reparse warning.

Node 22.18+ carries type stripping, but the bundle avoids depending on it. Effort is
about a day, dominated by the Dockerfile stage and CI wiring, not by code.

## Residual risks and what to smoke-test in the spike

- **Not tested live:** an actual `wss://` connection to a Vercel-Sandbox-exposed port
  with `endpoint.headers`, and `@vercel/sandbox` log streaming under Bun. Both use only
  the surfaces exercised above, but the spike should run one real session on the
  production image before anything ships.
- **Bun version drift:** `apps/chat-api/Dockerfile` uses the floating `oven/bun:1` tag
  (last pushed 2026-08-20 per Docker Hub); the local checks ran on Bun 1.3.0, so they are
  conservative relative to the image but not identical to it. Pin the tag in the spike.
- **`ws` shim gaps** (`handshakeTimeout`, `Sender`/`Receiver`, `createWebSocketStream`)
  are not used by the adapter today; a future adapter release could start using them.
  Re-run `ws-resolve.ts`/`ws-roundtrip.ts` when bumping `@ai-sdk/harness-claude-code`.
- **`undici` stub:** any future `@vercel/sandbox` feature that relies on a real undici
  `Dispatcher` (proxy, interceptors, `undici.stream`) would silently no-op or throw under
  Bun; today only `Agent({ bodyTimeout: 0 })` is used.
- **Image weight:** the Dockerfile's `--filter=chat-api` install currently keeps
  chat-api's `node_modules` around 145 MB; adding `ai`, `@ai-sdk/*`, `@vercel/sandbox`,
  and `undici` grows it modestly (20 packages for the sandbox SDK alone) and the
  unused `ws`/`undici` copies still land on disk.
