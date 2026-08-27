# What Survives Between Turns on the Claude Code Harness

**Research date: 2026-08-26.** This note resolves
[What survives between turns on the Claude Code harness?](https://github.com/X-GPT/mymemo-agent/issues/588)
for the `HarnessAgent` + `createClaudeCode` + `createVercelSandbox` path charted in
[#585](https://github.com/X-GPT/mymemo-agent/issues/585). Every upstream claim is pinned to
`vercel/ai` commit
[`56d492f`](https://github.com/vercel/ai/commit/56d492f61652af7bad16f56ed33cf41924ef5496)
(main, 2026-08-26) and to first-party Claude Code and Vercel Sandbox documentation as read on
the research date. Package versions at that commit: `@ai-sdk/harness` 1.0.91,
`@ai-sdk/harness-claude-code` 1.0.94, `@ai-sdk/sandbox-vercel` 1.0.91 (peer
`@vercel/sandbox ^2.0.1 || ^3.0.0`); the in-sandbox bridge pins
`@anthropic-ai/claude-agent-sdk` 0.3.213 and `@anthropic-ai/claude-code` 2.1.213
([bridge package.json](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/bridge/package.json)).

The prior notes #585 tells every session to load
(`docs/research/ai-sdk-harness-agent-api-2026.md` and
`docs/research/ai-sdk-harness-agentcore-sandbox-feasibility-2026.md`) are not present on
`main` or any remote branch as of `4a494e5`; this note therefore stands alone and does not
assume their content. Upstream PR [#19108](https://github.com/vercel/ai/pull/19108) ("local
workspaces") is still open and adds a host-local workspace mode; it does not change anything
below.

## Short answer

The S3 `agent-sessions/<conversationId>` blob **is not enough on its own**. On this harness the
conversation transcript never leaves the sandbox filesystem; the resume state the adapter hands
back is a pointer set, not a transcript. What has to outlive the turn is the **named, persistent
Vercel Sandbox** (specifically its auto-snapshot), not a running VM and not the bridge process.

1. **`detach()` / `stop()` return pointers only.** `detach()` yields `{ bridge: { port, token,
   lastSeenEventId, sandboxId? }, sandboxCredentialEnvironment? }`; `stop()` yields structurally
   `{}` plus the optional credential map. Neither contains a Claude session id, a thread id, or
   any transcript. The framework wraps it as
   `{ type: 'resume-session', harnessId: 'claude-code', specificationVersion: 'harness-v1', data }`.
2. **Claude's thread history lives only in the sandbox.** The bridge calls the Claude Agent SDK
   with `cwd: <workdir>` and `continue: true`, and passes no `sessionStore` and no `resume` id.
   The transcript is the CLI's own `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`
   (or `$CLAUDE_CONFIG_DIR/projects/...`). The bridge's replay log sits under
   `<defaultWorkingDirectory>/.agent-runs/<sessionId>/bridge/event-log.ndjson`. When the
   sandbox is deleted, or a non-persistent sandbox stops, all of it is gone.
3. **A Vercel Sandbox snapshot restores it.** Vercel sandboxes are persistent by default: stop
   or timeout auto-snapshots the filesystem, and `Sandbox.get({ name })` plus the next SDK call
   boots a new session from that snapshot. The provider names the per-session sandbox
   `ai-sdk-harness-session-<sessionId>` for exactly this reason, and strips `persistent` from
   the fork params so the per-session sandbox always takes Vercel's persistent default.
4. **`createSession({ resumeFrom })` fallback ladder** (after the framework has reattached the
   sandbox via `provider.resumeSession({ sessionId })`): **attach** to the still-running bridge
   using the persisted `port`/`token`; if that socket fails, **respawn** the bridge and send the
   next prompt with Claude `continue: true` (the "rerun" rung). Disk **replay** of
   `event-log.ndjson` is used only for `continueFrom` (a suspended, unfinished turn), never for
   a between-turn `resumeFrom`. There is no fresh-thread rung: if the workdir transcript is
   missing, `continue: true` simply starts a new Claude session in that cwd, silently.

For MyMemo this means: keep storing the `detach()`/`stop()` payload in S3 (it is small and
needed for attach and for credential brokering), **and** keep the Vercel sandbox
`ai-sdk-harness-session-<sessionId>` alive as a persistent resource for the Conversation's
lifetime, with `sessionId` = the Conversation's stable id so `resumeSession` can find it. The
only ways to make the S3 blob self-sufficient are to bypass the adapter's bridge and mirror
transcripts yourself (see [What would make S3 sufficient](#what-would-make-s3-sufficient)).

## Evidence

### 1. The serialized resume state

The v1 contract defines the envelope. Adapter payload is an opaque `data: JSONValue`; the
framework validates `type`, `specificationVersion`, and `harnessId`, then parses `data` against
the adapter's `lifecycleStateSchema`
([harness-v1-lifecycle-state.ts#L17-L45](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/v1/harness-v1-lifecycle-state.ts#L17-L45),
[lifecycle-state-validation.ts](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/internal/lifecycle-state-validation.ts)).

The Claude Code adapter's schema, verbatim
([claude-code-harness.ts#L784-L803](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L784-L803)):

```ts
const claudeCodeBridgeCoordsSchema = z.object({
  port: z.number(),
  token: z.string(),
  lastSeenEventId: z.number(),
  sandboxId: z.string().optional(),
});

/**
 * A `doStop()` payload is structurally empty (`{}`): the framework derives the
 * sandbox via `provider.resumeSession({ sessionId })`, and the Claude SDK's
 * `{ continue: true }` flag rehydrates the thread from the workdir. A
 * `doDetach()` payload additionally carries `bridge` coordinates for
 * cross-process `attach`. A loose object keeps both shapes valid.
 */
const claudeCodeResumeStateSchema = z.looseObject({
  bridge: claudeCodeBridgeCoordsSchema.optional(),
  sandboxCredentialEnvironment: z.record(z.string(), z.string()).optional(),
});
```

`doDetach` suspends the channel (bridge and sandbox keep running) and returns
([#L1820-L1841](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1820-L1841)):

```json
{
  "type": "resume-session",
  "harnessId": "claude-code",
  "specificationVersion": "harness-v1",
  "data": {
    "sandboxCredentialEnvironment": { "...": "only when credential brokering is active" },
    "bridge": { "port": 3000, "token": "<64 hex>", "lastSeenEventId": 42, "sandboxId": "<vercel sandbox id>" }
  }
}
```

`doStop` sends `stop` to the bridge, whose `onStop` returns `{}` with the comment "Claude
Code's session state lives in the workdir on the sandbox filesystem (captured by the sandbox
snapshot on stop); the resume payload is empty"
([bridge/index.ts#L132-L134](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/bridge/index.ts#L132-L134)).
If the socket is already closed the adapter synthesizes `{}` without a round-trip
([#L1879-L1955](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1879-L1955)).
The `stop()` payload is therefore:

```json
{ "type": "resume-session", "harnessId": "claude-code", "specificationVersion": "harness-v1",
  "data": { "sandboxCredentialEnvironment": { "...": "optional" } } }
```

`doSuspendTurn` (what `detach()`/`stop()` call when a turn is still running) returns the same
`bridge` coordinates under `type: 'continue-turn'`; the framework nests it as
`resumeFrom.continueFrom`
([#L1962-L1990](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1962-L1990),
[harness-agent-session.ts#L404-L462](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/harness-agent-session.ts#L404-L462)).

No field anywhere in these payloads names a Claude `session_id`; the bridge never reads one
from the SDK stream (grep of `session_id`/`sessionId` in the bridge finds nothing). The
framework's own `sessionId` is the caller-supplied `HarnessAgent` id, which is why
`createSession({ sessionId, resumeFrom })` requires the original id
([harness-agent.ts#L219-L233](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/harness-agent.ts#L219-L233)).

### 2. Where the transcript lives

The bridge drives the Claude Agent SDK with the session work dir as `cwd` and applies the
continuation rule "the host can force-continue (resume after a cross-process detach) by setting
`start.continue: true`; otherwise we continue every subsequent turn after the first one in this
bridge process"
([bridge/index.ts#L380-L388](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/bridge/index.ts#L380-L388)).
The `query()` options contain neither `sessionStore` nor `resume` nor `persistSession`
([#L339-L390](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/bridge/index.ts#L339-L390)).

Per Anthropic, "Claude Code stores sessions under `~/.claude/projects/<encoded-cwd>/*.jsonl`.
If you set the `CLAUDE_CONFIG_DIR` environment variable, look under
`$CLAUDE_CONFIG_DIR/projects/` instead", `continue` "finds the most recent session in the
current directory", and "Session files are local to the machine that created them"
([Agent SDK: Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions)). The
CLI page adds the 30-day `cleanupPeriodDays` retention and that the JSONL "entry format is
internal to Claude Code and changes between versions"
([Manage sessions: Where transcripts are stored](https://code.claude.com/docs/en/sessions#where-transcripts-are-stored)).

The work dir is `<defaultWorkingDirectory>/<harnessId>-<sessionId>` unless
`sandboxConfig.workDir` overrides it
([sandbox-bootstrap.ts#L68-L83](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/internal/sandbox-bootstrap.ts#L68-L83)),
so "most recent session in this cwd" is unambiguous per `HarnessAgent` session. On Vercel
`defaultWorkingDirectory` is the sandbox session's `cwd`
([vercel-network-sandbox-session.ts#L36](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L36)).

The bridge's own state is under `<defaultWorkingDirectory>/.agent-runs/<sessionId>/bridge/`
([claude-code-harness.ts#L923-L924](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L923-L924)):
`bridge-meta.json`, `start-config.json`, `rerun-start-config.json`, and `event-log.ndjson`, the
"disk mirror of the in-memory replay log" that lets a respawned bridge serve a host's resume
cursor
([harness/bridge/index.ts#L362-L365](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/bridge/index.ts#L362-L365),
[#L404-L410](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/bridge/index.ts#L404-L410)).

Upstream states the design intent outright: the work dir and bridge-state dir live under the
provider's persistent mount "so the workdir's CLI state (Claude's `~/.claude/projects/<dir>/*.jsonl`
thread history is keyed by working directory) and the bridge state files survive both
detach -> attach/replay and stop -> snapshot -> resume cycles"
([claude-code-bootstrap.ts#L5-L16](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-bootstrap.ts#L5-L16)).
Note the adapter only sets `HOME` on the bridge process when skills are configured
([claude-code-harness.ts#L1060](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1060));
otherwise `~/.claude` is wherever the sandbox user's `HOME` points. On Vercel that is moot
because the snapshot covers the whole filesystem (next section), but it matters for any provider
that persists only a mount.

Consequence: when the sandbox is deleted (`session.destroy()` calls `sandbox.stop()` then
`sandbox.delete()`,
[vercel-network-sandbox-session.ts#L119-L123](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L119-L123)),
or when a non-persistent sandbox stops, the transcript, the bridge log, and any files the
agent wrote are all gone, and nothing in S3 can rebuild them.

### 3. What a Vercel Sandbox snapshot restores

Vercel: "Persistence is the default. Every sandbox created with `Sandbox.create()` ... is
persistent unless you explicitly opt out." "When you stop a persistent sandbox, the SDK
automatically snapshots the filesystem. When you resume it, a new session boots from that
snapshot with a fresh session timeout." Stopping happens on manual `stop()` or on timeout.
"If a persistent sandbox is stopped and you call `runCommand`, `writeFiles`, or other SDK
methods on it, the SDK automatically starts a new session and retries the operation."
([Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), last updated
2026-08-25; [Snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), 2026-08-26.)
Snapshots "capture the state of a running sandbox, including the filesystem and installed
packages", and resuming "boots" a new session from the snapshot, so the bridge and the
`claude` process are never restored, only their files.

Retention that bounds the Conversation lifetime:

- `snapshotExpiration` "Defaults to 30 days", measured from the snapshot's last use; `0` keeps
  indefinitely. `keepLastSnapshots: { count: 1 }` keeps storage flat.
- "Vercel removes sandboxes that can't resume from a snapshot after 14 days of inactivity."
- Snapshots are region-pinned; resuming in another region fails with
  `snapshot_region_mismatch`.
- `sandbox.stop()` "returns the final session state. For persistent sandboxes, the resolved
  value also includes metadata for the snapshot captured during shutdown"; `Sandbox.get`'s
  `resume` option "Defaults to `true`"
  ([JS SDK Reference](https://vercel.com/docs/sandbox/sdk-reference), 2026-08-21).

How the provider uses this
([vercel-sandbox.ts](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-sandbox.ts)):

- `createSession({ sessionId })` names the sandbox `ai-sdk-harness-session-<sessionId>` "so a
  future `resumeSession({ sessionId })` can locate it via `Sandbox.get({ name })`"
  ([#L150-L156](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-sandbox.ts#L150-L156)).
- With the Claude Code bootstrap recipe present (it always is), the per-session sandbox is a
  fork of a persistent template snapshot, and the fork params drop `persistent`, so the session
  sandbox always inherits Vercel's persistent default; `snapshotExpiration` and `timeout` from
  your settings are forwarded ([#L221-L244](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-sandbox.ts#L221-L244)).
  Default `timeout` is 30 minutes ([#L61-L65](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-sandbox.ts#L61-L65)).
- `resumeSession({ sessionId })` is `Sandbox.get({ name })` with the same derived name
  ([#L246-L272](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-sandbox.ts#L246-L272)).
  No sandbox id is read from `resumeFrom.data.bridge.sandboxId`; the `sessionId` is the lookup key.
- `session.stop()` on a harness-owned sandbox calls `sandbox.stop()` (the auto-snapshot
  point); `destroy()` deletes it
  ([vercel-network-sandbox-session.ts#L114-L123](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L114-L123),
  [harness-agent-session.ts#L459](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/harness-agent-session.ts#L459)).

So a snapshot does restore the Claude transcript, the bridge state, the work dir, and the
installed CLI, provided the sandbox was persistent and the resume happens within the snapshot
and 14-day inactivity windows, in the same region.

### 4. The exact fallback ladder on `createSession({ resumeFrom })`

Framework step first: `HarnessAgent.createSession` validates the payload, then, because
`resumeFrom` is set, requires `provider.resumeSession` (throws
`HarnessCapabilityUnsupportedError` for providers without it) and calls it with the
`sessionId`
([harness-agent.ts#L326-L350](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/agent/harness-agent.ts#L326-L350),
[harness-v1-sandbox-provider.ts#L57-L70](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/src/v1/harness-v1-sandbox-provider.ts#L57-L70)).
If the named sandbox no longer exists, `Sandbox.get` fails and `createSession` throws; there
is no silent fresh-sandbox fallback. If a caller-owned `sandboxSession` is passed instead, the
framework uses it as-is and re-applies the idempotent bootstrap recipe.

Adapter step, `doStart`
([claude-code-harness.ts#L961-L1175](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L961-L1175)):

| Rung | Condition | Action | Claude thread |
| --- | --- | --- | --- |
| 1 ATTACH | `data.bridge` present and a WebSocket to `port` with `token` opens (bridge process still alive, so the VM never stopped) | Reuse the running bridge; no spawn, no new token; `continueOnFirstPrompt: false` | Bridge process is past its first turn, so the SDK's in-process `continue: true` rule applies |
| 2 REPLAY | Only for `continueFrom` (suspended turn) **and** `.agent-runs/<id>/bridge/event-log.ndjson` classifies as replayable | Respawn bridge with `BRIDGE_REPLAY_FROM_DISK=1`, seed `lastSeenEventId`, open with `{ resume: true }`; streams the finished tail | Not re-driven; the disk log is the source |
| 3 RERUN | Any `resumeFrom` whose attach failed (bridge gone: VM stopped, timed out, or snapshot-resumed); or `continueFrom` with an unusable log | Respawn bridge, skip `mkdir`/skills rewrite ("they already exist in the sandbox snapshot"), force `continue: true` on the next `start` | CLI reloads the most recent session in the work dir from `~/.claude/projects/...` |

The ladder comment is explicit that between-turn resumes never replay: "`resumeFrom` is a
between-turn resume; even when it carries bridge coordinates, replaying the previous turn would
re-deliver stale events into the next turn. Those resumes always `rerun` when attach is
unavailable (the CLI continues its own thread from the workdir snapshot via `continue: true`)"
([#L1019-L1040](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1019-L1040)).
The forced flag is applied once, on the first `start` after a respawn
([#L1529-L1534](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1529-L1534),
[#L1729](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1729)).
For a suspended turn that fell to rerun, `doContinueTurn` sends a literal `'Continue.'`
prompt with `continue: true` and documents it as "Lossy — work in flight at the suspension is
recomputed"
([#L1736-L1800](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness-claude-code/src/claude-code-harness.ts#L1736-L1800)).

There is no rung that consults an external transcript, and no rung that detects a missing
transcript. Under `continue: true` with no session on disk in that cwd, the TypeScript SDK
"starts a fresh session"; Anthropic documents this for the store-miss case
([Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage#resume-from-the-store)),
and the no-store case is not documented, so #590 should confirm it. Either way the user would
see a Claude that has forgotten the Conversation, with no error from the harness.

### 5. What this means for MyMemo's S3 blob

Today `agent-query-runtime` stores a *real* transcript: it runs the SDK in-process with an
`InMemorySessionStore`, `CLAUDE_CONFIG_DIR` pointed at a temp dir, and `resume: sessionId`,
then serializes `{ version: 1, sessionId, transcripts: [...] }` to
`agent-sessions/<conversationId>`
([response-execution.ts](https://github.com/X-GPT/mymemo-agent/blob/4a494e5147cf179e4dc867a2d10ee14076093b43/apps/agent-query-runtime/src/response-execution.ts#L19-L38),
[#L110-L127](https://github.com/X-GPT/mymemo-agent/blob/4a494e5147cf179e4dc867a2d10ee14076093b43/apps/agent-query-runtime/src/response-execution.ts#L110-L127),
[detached-session-store.ts](https://github.com/X-GPT/mymemo-agent/blob/4a494e5147cf179e4dc867a2d10ee14076093b43/apps/agent-query-runtime/src/detached-session-store.ts)).
That blob is self-sufficient because the SDK's `SessionStore` mirror is the transcript.

On the harness path the same key would hold the `HarnessAgentResumeSessionState` above:
a few hundred bytes of bridge coordinates and, with credential brokering, the sandbox-side
credential environment. It is worth keeping (attach is the fast path, and re-minting a
credential environment on every turn is avoidable), but it is not a transcript. The durable
unit of Conversation memory becomes the Vercel sandbox `ai-sdk-harness-session-<sessionId>`
and its latest snapshot. Two design consequences follow:

- `sessionId` passed to `createSession` must be stable per Conversation (use the
  Conversation id), because it is the only key `resumeSession` has.
- The sandbox must not be `destroy()`ed at end of turn. `stop()` (auto-snapshot) or
  `detach()` (leave running until `timeout`, then auto-snapshot) are both fine; the Conversation
  then lives as long as the snapshot (`snapshotExpiration`, default 30 days from last use)
  and the 14-day inactivity sweep allow. Set `keepLastSnapshots: { count: 1 }` to avoid a
  snapshot per turn accumulating.

Also note `stop()` after a suspended turn does **not** stop the sandbox in the same call path
as an idle `stop()` (it returns `continueFrom` and the finally block still calls
`sandboxSession.stop()`, which kills the in-flight bridge); resumption then lands on the
lossy rerun rung. Treat interrupted turns as a separate ticket, as #585 already defers.

### What would make S3 sufficient

Only by moving the transcript into MyMemo's hands, which the shipped adapter does not expose:

1. **Copy the JSONL yourself.** Anthropic documents "Move the session file": persist
   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl` and restore it before resuming
   ([Resume across hosts](https://code.claude.com/docs/en/agent-sdk/sessions#resume-across-hosts)).
   With the harness this means reading the file out of the sandbox after each turn and
   writing it back in `sandboxConfig.onSession` (which "runs for fresh and resumed sessions",
   [harness README](https://github.com/vercel/ai/blob/56d492f61652af7bad16f56ed33cf41924ef5496/packages/harness/README.md)),
   then creating a fresh sandbox and calling `createSession` with `resumeFrom` omitted but
   the same work dir. The format is "internal to Claude Code and changes between versions",
   and the bridge pins CLI 2.1.213, which predates the cross-directory lookup added in
   2.1.223, so the restored path must match the encoded cwd exactly.
2. **Own the bridge.** A MyMemo-specific `HarnessV1` adapter (the host-driven shape #585 rules
   out for this map) could pass `sessionStore` + `resume` to the SDK the way
   `agent-query-runtime` does today, making the S3 blob the transcript again.

Neither is needed for stage 1 if the persistent sandbox is accepted as the Conversation's
memory. Decide that explicitly; do not assume the blob covers it.

## Open items for #590 (the spike)

- Confirm rung 3 in practice: `stop()` the session, wait for the sandbox to report `stopped`,
  then `createSession({ sessionId, resumeFrom })` in a new process and check that turn two
  recalls turn one. This exercises `Sandbox.get` auto-resume plus `continue: true`.
- Record the `resumeFrom` byte size and whether `sandboxCredentialEnvironment` is present under
  the OpenRouter `env` configuration (it is only set when the sandbox session supports
  `addRequestTransformations`, which the Vercel network session does).
- Check what `HOME` resolves to for the bridge process in the Vercel `node24` runtime, so the
  `~/.claude/projects` location is known for the JSONL-copy option above.
