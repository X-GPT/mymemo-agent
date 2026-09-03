# The SDK `SessionStore` contract and Anthropic's S3 example (v3 research, #703)

Date: 2026-09-03. Part of map #701; answers doc §17.2 of the
[v3 design baseline](https://github.com/X-GPT/mymemo-agent/blob/research/v3-design-doc/docs/research/v3-claude-managed-agent-aws-architecture-2026.md#172-claude-agent-sdk-sessionstore).

## Sources and how to read the labels

Primary sources, in order of authority for this repo:

- **T** — the type definitions shipped in the pinned SDK,
  `@anthropic-ai/claude-agent-sdk@0.3.251` (`apps/in-vm-server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, line numbers below are from that file). `apps/agentcore-runtime` still pins **0.3.233**; its `SessionStore` block is byte-identical to 0.3.251's (diffed 2026-09-03), so the contract below holds for both — the one version-gated feature is called out where it matters.
- **B** — the SDK's own bundle, `sdk.mjs` in the same package (minified; read to confirm behaviour the docs only describe). Facts sourced only from B are marked *(inferred from bundle)* — they are what the code does today, not a documented promise.
- **D-storage** — [Persist sessions to external storage](https://code.claude.com/docs/en/agent-sdk/session-storage).
- **D-sessions** — [Work with sessions](https://code.claude.com/docs/en/agent-sdk/sessions) (SDK) and [Manage sessions](https://code.claude.com/docs/en/sessions) (Claude Code).
- **D-hosting** — [Hosting the Agent SDK](https://code.claude.com/docs/en/agent-sdk/hosting).
- **S3** — Anthropic's reference adapter, [`examples/session-stores/s3/src/S3SessionStore.ts`](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/s3/src/S3SessionStore.ts), its [README](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/README.md), [tests](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/s3/test/S3SessionStore.test.ts), [demo](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/s3/demo.ts) and the shared [conformance suite](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/examples/session-stores/shared/conformance.ts) (read at `main`, 2026-09-03).
- **CL** — the SDK [CHANGELOG](https://github.com/anthropics/claude-agent-sdk-typescript/blob/main/CHANGELOG.md).

Labels: **documented** = stated in T or D; **inferred** = read from B or S3 source, or a consequence I drew; **unknown** = not found in any primary source.

## 1. The `SessionStore` contract on 0.3.251

### 1.1 Types (documented, T 5295–5493)

```ts
type SessionKey = {
  projectKey: string;   // "Caller-defined scope. Default: sanitized cwd."
  sessionId: string;
  subpath?: string;     // undefined = main transcript; 'subagents/agent-{id}' for subagents. Opaque suffix.
};

type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;   // required
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;             // required
  listSessions?(projectKey: string): Promise<Array<{ sessionId: string; mtime: number }>>;
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: { projectKey: string; sessionId: string }): Promise<string[]>;
};

type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown };
```

The whole surface is `@alpha` (T 5393, 5486). `SessionStoreEntry` is deliberately a "minimal structural supertype": the concrete union "is CLI-internal and not part of the SDK API surface … Adapters should treat entries as pass-through blobs; round-tripping `JSON.stringify` / `JSON.parse` is the only required invariant" (T 5475–5486). D-sessions adds that the on-disk entry format "is internal to Claude Code and changes between versions". This confirms the design doc's "opaque JSON-safe data, saved as-is, loaded in order".

### 1.2 `append` — batching, ordering, idempotency (documented, T 5396–5416)

- Called **after** the subprocess's local JSONL write succeeds; "durability is already guaranteed locally".
- **Batched, not per entry.** "Batches arrive at ~100ms cadence during active turns." Entries are "JSON-safe POJOs — one per line in the local JSONL file."
- **Ordering:** "Within a single process, persist entries in append-call order; across concurrent processes, order is by storage commit time, not call time." The SDK offers no cross-process ordering guarantee.
- **Idempotency:** "Most entries carry a stable `uuid`. Adapters SHOULD treat `uuid` as an idempotency key (upsert / ignore-duplicate) so that retries and `importSessionToStore()` replays do not create duplicate rows. Entries without a `uuid` (e.g. titles, tags, mode markers) should be appended without dedup." D-storage: "Because a retried batch can re-deliver entries that already landed, deduplicate by `entry.uuid` in your `append()` implementation." So the design doc's "append() must dedupe by entry UUID" is the SDK's own recommendation — and §3 shows the S3 example does **not** do it.
- **Retry:** "Rejection is retried (3 attempts total) with short backoff; timeouts (60s) are not retried since the in-flight call may still land. After the final failure the batch is dropped and a `mirror_error` system message is emitted. The subprocess continues unaffected." Retry was added in 0.2.119 (CL).

Batching mechanics *(inferred from bundle)*: the CLI sends `transcript_mirror` frames `{ filePath, entries }` to the SDK parent, which routes them through a `TranscriptMirrorBatcher` (B, class `pC`). The batcher groups pending frames by file path and drains when pending exceeds **500 entries or 1 MiB**, on every `result` message, and on stream end/cleanup; per-call timeout 60 000 ms; backoff `[200, 800]` ms (three attempts). `Options.sessionStoreFlush` (T 5495–5506, documented): `'batched'` (default) "flush at end-of-turn or when pending thresholds are exceeded"; `'eager'` "schedule a background flush after every frame … Each frame becomes its own `append()` batch (no coalescing)". In batched mode a normal Turn therefore produces roughly **one `append()` per transcript file per Turn** (more if it crosses 500 entries / 1 MiB); in eager mode one per frame. The SDK converts the frame's `filePath` back into a `SessionKey` by parsing `<projectsDir>/<projectKey>/<sessionId>[.jsonl | /<subpath>.jsonl]`; a frame whose path is not under the parent's `CLAUDE_CONFIG_DIR/projects` is **dropped with a warning** (B; the T 1673 comment says the same about `spawnClaudeCodeProcess`).

### 1.3 `load` — when and how (documented, T 5418–5429; D-storage "Resume from the store")

- "Called once, in the SDK parent, before subprocess spawn. The result is materialized to a temporary JSONL file; the subprocess resumes from that file using its existing resume code."
- Return `null` for a never-written key; adapters that cannot tell "never written" from "emptied" may return `null` for both.
- "Returned entries must be deep-equal to what was appended — byte-equal serialization is NOT required … the SDK never hashes or byte-compares entries."
- `Options.loadTimeoutMs` (default 60 000) bounds each `load()` / `listSubkeys()` during resume; on expiry "the query fails with a clear error instead of hanging" (T 1696–1704).
- Materialisation *(inferred from bundle, matches D-storage)*: the SDK writes the entries to `<tmp>/claude-resume-*/projects/<projectKey>/<sessionId>.jsonl`, copies credentials, `.claude.json` and a sanitised user `settings.json` into that temp dir, calls `listSubkeys` (if implemented) and `load`s each subpath (rejecting `..` / absolute / escaping subpaths), then spawns the CLI with `CLAUDE_CONFIG_DIR` pointing at the temp dir and deletes it after exit. D-storage: on this path "the local copy is deleted at run end, so the store holds the only durable copy" and "a dropped batch has no surviving copy once the run ends".
- If the store returns nothing for `resume: id`, "both SDKs pass the ID through to the subprocess, which resumes the local transcript exactly as `resume` does without a store" (D-storage) — i.e. a miss is **not** an error at the SDK layer; the CLI then either finds a local file or fails on its own terms. **Unknown:** the exact CLI error shape for a session that exists nowhere (not in any primary source read).

### 1.4 The optional methods

- `listSessions(projectKey)` (T 5430–5441): returns ids + `mtime` as integer epoch ms; "Result order is unspecified — the SDK sorts by mtime descending." Required for `continue: true` and for `listSessions({ sessionStore })` (D-storage table).
- `listSessionSummaries` (T 5442–5457): optional one-round-trip metadata; maintained inside `append()` via the exported pure `foldSessionSummary`; the store "MUST serialize sidecar writes if `append()` calls can race for the same session". Not needed for resume.
- `delete` (T 5458–5462): "Optional — if undefined, deletion is a no-op (appropriate for WORM/append-only backends like S3)." Only ever called by `deleteSession({ sessionStore })` (T 554–567); "The SDK never deletes from your store on its own. Retention is the adapter's responsibility" (T 5385–5392, D-storage "Retention"). Deleting the main key must cascade to subkeys (D-storage table; conformance test "delete main cascades to subkeys").
- `listSubkeys` (T 5463–5472): "Used during resume to discover and materialize all subagent data. If undefined, resume only materializes the main transcript."

### 1.5 Options that interact with `sessionStore` (documented, T)

| Option | Effect with a store | Source |
|---|---|---|
| `resume: id` | `load()` in the parent, materialise, spawn with temp `CLAUDE_CONFIG_DIR` | T 1893–1896, D-storage |
| `continue: true` | SDK calls `store.listSessions(projectKey)`, picks newest `mtime`, then behaves as `resume`; **throws at startup if `listSessions` is undefined**; if the store is empty the SDK "starts a fresh session" | D-storage; B (`Options.continue with sessionStore requires store.listSessions to be implemented`) |
| `sessionId: uuid` | "Use a specific session ID … instead of an auto-generated one. Must be a valid UUID. Cannot be used with `continue` or `resume` unless `forkSession` is also set" | T 1897–1902 |
| `forkSession: true` | with `resume`: new session id, history copied; via the store it "reads the source entries, rewrites every `sessionId` field and remaps message UUIDs, then appends … under a new key" — not a `CopyObject` | T 1565–1569, D-storage |
| `resumeSessionAt` / `resumeDropsTurn` | truncating resume; print/headless lane only | T 1903–1960 |
| `persistSession: false` | **throws** with a store ("local writes are required for the mirror") | T 1676–1680, D-storage |
| `enableFileCheckpointing` | **throws** with a store (backups are not mirrored) | B; D-storage |
| `sessionStoreFlush` | `'batched'` (default) / `'eager'` | T 1688–1695 |
| `loadTimeoutMs` | default 60 000 | T 1696–1704 |
| `env` | **replaces** the subprocess environment (spread `process.env`) — and is where `CLAUDE_CONFIG_DIR` / `CLAUDE_CODE_PROJECT_DIR_NAME` go | CL 0.2.113 ("Breaking"), D-hosting |

Mutual exclusion: `continue` and `resume` are "Mutually exclusive" (T 1451–1454).

### 1.6 When the session id is first exposed (documented)

- `SDKSystemMessage` (`type: 'system', subtype: 'init'`) carries `session_id: string` (T 4952–5010). D-sessions: "In TypeScript the ID is also available earlier as a direct field on the init `SystemMessage`"; every `SDKResultMessage` "regardless of success or error" carries it too (T 4809, 4859). Anthropic's own S3 demo captures it from `init` (S3 demo.ts).
- The design doc's step 3 ("take `claudeSessionId` from the init System Message as early as possible") is therefore supported. A simpler lever exists: **pre-mint the id with `Options.sessionId`** (T 1897) so the Runner can write it to DynamoDB *before* `query()` and never race the stream. *Inferred, not probed:* nothing in T or B forbids combining `sessionId` with `sessionStore` on a fresh session (B forwards `sessionId` to the CLI unchanged; the mirror key is parsed from the CLI's file path, which uses that id). Worth one probe before relying on it.

### 1.7 `mirror_error` (documented)

`SDKMirrorErrorMessage = { type: 'system', subtype: 'mirror_error', error: string, key: { projectKey, sessionId, subpath? }, uuid, session_id }` (T 4556–4569). It is "Emitted when SessionStore.append() rejects or times out for a transcript-mirror batch after bounded retry … The batch is then dropped; this surfaces the failure so consumers are not silent on data loss." It arrives **in the normal message iterator**, the query **continues** (D-storage "Mirror writes are best-effort"; D-hosting "drops the batch, emits … and continues the query. Alert on these if store durability matters"). The docs' recommendation is monitoring, not aborting. Consequences for v3: after a `mirror_error` the S3 copy has a hole; if the Runner then dies, the SDK session is unrecoverable from S3 — exactly the design doc's "the Run must not be silently treated as fully recoverable". Whether to abort the Attempt (ADR-0005's choice, §4) or mark the SDK session "tainted → cold-recovery next time" is a v3 spec decision; the SDK supports either.

## 2. `projectKey`: derivation, `continue` scope, pinning

### 2.1 Derivation (documented + inferred)

- Documented: default is the "sanitized cwd"; "Multi-tenant deployments should set this to a tenant ID or project name. Paths longer than 200 characters are truncated and suffixed with a portable djb2 hash so the same path yields the same key under both Bun and Node.js" (T 5296–5299). D-sessions: replace every non-alphanumeric character in the **absolute** working directory with `-` (`/Users/me/proj` → `-Users-me-proj`); over 200 characters → truncate to 200 and append a hash.
- *Inferred from bundle:* the SDK-side key for `load`/`listSessions` is `ro(cwd, env)`: `cwd` is `path.resolve`d and **realpath-resolved** (symlinks collapse), then `replace(/[^a-zA-Z0-9]/g, "-")`, truncation at 200 + hash of the full raw path. The key the store sees on `append` is parsed from the CLI's on-disk path, which the CLI derives with the same shared function — agreement is by construction, not checked at runtime.

### 2.2 Is `continue: true` project-key-scoped? — **yes** (documented)

D-storage: "`continue: true` … the SDK asks for the store's newest session"; the lookup is `store.listSessions(projectKey)` for the *current* cwd-derived key, sorted by `mtime` desc, first wins (B, and the D-storage table: "`listSessions` … By `query()`/`startup()` with `continue: true`"). With a shared multi-tenant store and one Runner cwd this would pick **whichever Session on the whole platform appended last** — the design doc's reason to forbid `continue` is correct. `resume: <id>` never consults `listSessions`.

### 2.3 Can the key be pinned? — **yes, since SDK 0.3.234 / CLI 2.1.234** (documented)

D-storage: "if you set `CLAUDE_CODE_PROJECT_DIR_NAME` beside `CLAUDE_CONFIG_DIR` in a query's `env` option, the SDK keys that query's entries, and its `resume` and `continue` lookups, by that name instead … Requires Agent SDK v0.3.234 or later." D-sessions (Claude Code): value must be 1–64 `[A-Za-z0-9_-]`, not a Windows device name, otherwise ignored; **ignored when `CLAUDE_CONFIG_DIR` is unset**; read once at startup from the process environment. *Inferred from bundle:* the SDK honours the pair from `options.env` when `env` is passed, else from `process.env` (`ro()` → `HE(env.CLAUDE_CODE_PROJECT_DIR_NAME)` only if `env.CLAUDE_CONFIG_DIR` is truthy), matching the docs; the validation regex is `^[A-Za-z0-9_-]{1,64}$`.

Consequences:
- The pinned SDK (0.3.251) qualifies; `apps/agentcore-runtime`'s 0.3.233 does **not** (the env var is not mentioned in CL at all — the docs are the only source for the version gate, so verify on the real binary once).
- The design doc's "deterministic and stable Project Key / working-directory identity" can be met **without** encoding the Session id into `cwd`: set `CLAUDE_CONFIG_DIR=<per-Session dir>` + `CLAUDE_CODE_PROJECT_DIR_NAME=<Session id or constant>`; D-hosting recommends per-tenant `CLAUDE_CONFIG_DIR` anyway. Note the D-hosting caveat that the short-name trick is framed for "when … you don't share a `SessionStore` across tenants" — with one shared bucket, make the name (or the S3 prefix) tenant-unique so `projectKey` collisions cannot cross tenants.
- Alternative that needs no env var and works on 0.3.233: a Session-stable `cwd` (`/workspace/<sessionId>`), which is what ADR-0005 does (§4). Both give a key the Runner can compute independently; the S3 example needs that key to *list* objects, which is why it matters (§3).

## 3. What Anthropic's S3 example actually does (inferred from S3 source; README claims marked)

Status (README): "Reference implementations. Not published to npm, not maintained as production code … not built or tested by this repository's CI. Each adapter passes the 13-contract conformance suite." D-storage says the same and tells you to copy `src/S3SessionStore.ts` and install `@aws-sdk/client-s3`.

### 3.1 Object layout

```
s3://{bucket}/{prefix}{projectKey}/{sessionId}/part-{epochMs13}-{rand6}.jsonl                 main transcript
s3://{bucket}/{prefix}{projectKey}/{sessionId}/{subpath}/part-{epochMs13}-{rand6}.jsonl       e.g. subagents/agent-<id>
```

`prefix` is normalised to end in exactly one `/` (or empty). `ContentType: application/x-ndjson`.

### 3.2 Part granularity and ordering

- **One object per `append()` call**; `append([])` writes nothing. With the SDK's default batched flush that is ≈ one part per transcript file per Turn (§1.2).
- Part name = zero-padded 13-digit `Date.now()` + 6 hex random chars. Within one store instance `ms = max(now, lastMs + 1)` makes same-ms appends strictly increasing; the random suffix "disambiguates instances". README: "Part-file ordering uses the **client-side wall clock**. Multiple writer instances with clock skew >1s may produce out-of-order `load()` results. Use NTP or a single writer per session."
- `load()` = `ListObjectsV2` with `Delimiter: '/'` (direct children only — the comment explains that without it subagent parts would leak into the main transcript "corrupting resume"), lexicographic sort of keys, then `GetObject` in batches of 16 in parallel, concatenating in sorted order; malformed lines are skipped silently; returns `null` if no parts. Pagination is handled (`ContinuationToken`).
- `listSessions(projectKey)` lists the whole project prefix without a delimiter, keeps only one-level-deep keys, and derives `mtime` from the **part filename's epoch** (falling back to `LastModified`) — i.e. client clock again.
- `listSubkeys` lists everything under the session prefix and returns every distinct directory path minus the part file, filtering `..`/`.`/empty segments ("Defense-in-depth … Primary traversal guard stays in materializeResumeSession").
- `delete` is implemented (`DeleteObjects`, quiet, paginated): whole-session delete cascades into subpaths, subpath delete is exact-key only. Required IAM (README): `s3:PutObject`, `s3:GetObject`, `s3:ListBucket`, `s3:DeleteObject`.

### 3.3 Duplicates, compaction, concurrency — what it does **not** do

- **No uuid dedupe anywhere.** A retried batch whose first attempt actually landed (client saw an error, S3 committed) becomes a second part with the same entries, and `load()` returns them twice. The conformance suite has **no duplicate-delivery contract** (13 tests: order, null for unknown, `append([])`, subpath isolation, projectKey isolation, listSessions, delete cascade, listSubkeys); the S3 unit tests add key format, same-ms ordering, malformed-line skipping, traversal filtering, prefix normalisation — nothing about duplicates. So "passes conformance" ≠ "safe under retry".
- **No compaction.** README: "For sessions with >1000 part files, `load()` paginates correctly but latency grows linearly; consider periodic compaction." Nothing in the example compacts; a compactor is ours to write if needed.
- **No concurrency control / fencing.** Two writers on the same key simply interleave by wall clock. Nothing stops a stale writer from landing a part after a newer Attempt has already loaded and appended. `listSessionSummaries` is not implemented, so there is no sidecar to race on.
- **No integrity check** on `load()` beyond JSON parse; no ETag/versioning use.
- **Clock coupling:** ordering **and** `listSessions().mtime` both come from the writer's clock. The contract wants `mtime` on "the same clock it uses for `listSessions().mtime`" (T 700–717) — satisfied trivially here, but a skewed Runner writes parts that sort into the past.

### 3.4 Load cost model (inferred)

Resume = 1 `ListObjectsV2` per 1 000 parts + `N/16` rounds of `GetObject` for the main transcript, plus the same per subagent subpath, all before the CLI spawns and all inside `loadTimeoutMs` (60 s default). For a Session with hundreds of Turns that is hundreds of small GETs per Attempt start; fine for S3 latency budgets but it is the number to watch, and the only reason to ever compact.

## 4. Prior art in this repo vs the S3 example

| Aspect | `packages/agent-db/src/session-store.ts` + `apps/agentcore-runtime/src/sdk/session-store.ts` (ADR-0005) | Anthropic S3 example | SDK contract |
|---|---|---|---|
| Lookup key | `conversationId` (bound at adapter construction) + `sessionId` + `subpath`; **`projectKey` stored but never a lookup key** — the adapter comment says so explicitly | `projectKey/sessionId[/subpath]` — projectKey **is** the namespace; the Runner must reproduce it exactly to list | `SessionKey` is `{projectKey, sessionId, subpath?}` |
| projectKey stability | Session-stable `cwd` `/workspace/conversations/<id>` (`conversationWorkingDirectory`) | none — caller's problem | default sanitized cwd; pin via `CLAUDE_CODE_PROJECT_DIR_NAME` + `CLAUDE_CONFIG_DIR` (≥ 0.3.234) |
| uuid dedupe | yes — unique `(conversation, session, subpath, uuid)` index, `ON CONFLICT DO NOTHING`; uuid-less rows always insert | **no** | SHOULD dedupe by `uuid` |
| Ordering | `bigserial id` (server commit order) | part filename = client wall clock + random | in-process append order; cross-process "storage commit time" |
| `mtime` | `max(created_at)` server clock | part filename epoch (client clock) | integer ms, same clock as summaries |
| Fencing | every append/delete locks the Conversation Ownership fence `FOR SHARE`; a stale owner's write is rejected and writes nothing | none | none — "across concurrent processes, order is by storage commit time" |
| `mirror_error` | **fatal**: stops the Run (`run-serving.ts:545`, `agent-stream.ts`); cannot establish a first resume pointer | n/a (adapter) | best-effort; query continues; "monitor" |
| Resume pointer | `conversation_runtime.agent_session_id`, written only after a successful non-empty main-transcript mirror inside a fenced terminal transaction | n/a — demo captures `init.session_id` | id is on `init` and every `result`; can be pre-set with `Options.sessionId` |
| `delete` | fenced; whole-Conversation delete on Conversation deletion | `DeleteObjects` cascade | optional; SDK never calls it on its own |
| `listSessions(projectKey)` | ignores the argument, lists by bound conversation | lists the project prefix | must return `{sessionId, mtime}` |

Where the assumptions diverge, and what that means for v3:

1. **Fencing lives in the adapter in ADR-0005; the S3 example has none.** The v3 premise "no custom fencing until recovery's stale-write question is answered" therefore means accepting, for now, that a stale Runner's final `flush()` (which the SDK runs on every `result` and on cleanup) can land in S3 *after* a new Attempt has loaded. Because S3 orders by writer clock, that late part sorts by *when it was written*, i.e. after the new Attempt's parts — the next `load()` would present the stale tail as the newest history. This is the concrete "stale-write question" for the recovery ticket; the S3 example gives no protection and the contract promises none.
2. **Dedupe moved from the adapter to nowhere.** The design doc requires uuid-idempotent `append()`; the S3 example must be modified to get it. Cheapest correct place is `load()` (drop later entries whose `uuid` was already seen while concatenating — keeps order, survives retries and `importSessionToStore` replays, costs nothing on the write path); doing it in `append()` would need a read-before-write against S3. *Inferred recommendation, not a documented pattern.*
3. **`mirror_error` policy is ours to choose.** ADR-0005 chose fatal because the Run could not be trusted to resume; the docs choose continue-and-alert. The design doc's wording ("the Run should not be silently treated as fully recoverable") is compatible with either; it is a spec decision, not an SDK constraint.
4. **The Postgres adapter never needed a reproducible `projectKey`; S3 does.** Whichever pinning route the spec picks (env pair on 0.3.251, or Session-stable cwd), it must be one the Runner can recompute from the Session record alone, because `resume` calls `load({projectKey: <derived from cwd/env>, sessionId})` and the S3 adapter lists exactly that prefix.
5. **First-pointer evidence.** ADR-0005 only trusts a session id after a successful non-empty mirror. With S3 the equivalent signal is "`append()` returned for the main key at least once"; the reference adapter does not surface that, so the Runner-side wrapper needs the same `mirroredMainSessionId()` idea if the spec keeps that rule — or pre-mints the id (§1.6) and treats a missing S3 prefix on resume as cold recovery.

## 5. Answers to the ticket, compact

- **Interface**: `append`/`load` required; `listSessions`, `listSessionSummaries`, `delete`, `listSubkeys` optional; all `@alpha`; identical on 0.3.233 and 0.3.251 (T).
- **`append` is batched** (~100 ms frames coalesced; default flush at end of Turn or 500 entries / 1 MiB; `'eager'` = one call per frame). Order guaranteed only within a process; retried 3× on rejection, not on timeout; failure → batch dropped + `mirror_error`, query continues (T, D-storage; thresholds from B).
- **An entry** is opaque JSON with `type` and usually `uuid` + `timestamp`; the SDK says dedupe on `uuid` (T).
- **`load`** runs once in the SDK parent before spawn, materialises to a temp `CLAUDE_CONFIG_DIR`, 60 s timeout, must return deep-equal entries in order or `null` (T, D-storage).
- **Session id** is on the `init` system message and on every `result`; can be pre-set with `Options.sessionId` (UUID) on a fresh session (T, D-sessions).
- **`continue: true`** = newest `mtime` under the current `projectKey` via `store.listSessions`; throws if the store lacks `listSessions`; forbidden for v3 as the doc says (D-storage, B).
- **`projectKey`** = sanitized realpath cwd (200-char cap + djb2 hash); pin with `CLAUDE_CODE_PROJECT_DIR_NAME` + `CLAUDE_CONFIG_DIR` in `env` on SDK ≥ 0.3.234 (D-storage, D-sessions, T, B).
- **S3 example**: one part object per `append`, `load` = list + sort + 16-way GET; ordering by writer wall clock; **no uuid dedupe, no compaction, no fencing, delete implemented**; README warns about clock skew, >1000 parts, and that it is not production code (S3, README).
- **Repo prior art** dedupes, fences and orders server-side and treats `mirror_error` as fatal; none of that is in the S3 example (§4).

## 6. Open unknowns

1. Whether `Options.sessionId` (pre-minted UUID) composes with `sessionStore` on a fresh session — nothing forbids it in T/B, not documented, not probed.
2. The CLI's error shape when `resume: id` misses both the store and local disk (D-storage says the id is passed through; the failure mode is not described).
3. Whether `CLAUDE_CODE_PROJECT_DIR_NAME` is honoured by the **0.3.251 bundled CLI** in practice — the SDK side is in B; the CLI-side gate is documented as v2.1.234 and the SDK pins parity with 2.1.251 (CL), so it should be, but it is unverified on the real binary.
4. Exact `transcript_mirror` frame cadence and whether the `init` message is emitted before the first `append()` — irrelevant if the id is pre-minted, load-bearing if v3 keeps the "capture from init, conditional-write" step.
5. Whether a late `flush()` from a stale Runner is bounded in time — the SDK flushes on `result` and on cleanup with a 60 s per-call timeout, so a stale tail can land up to ~60 s (plus retries' backoff) after the Runner lost its lease; the recovery ticket owns this.
6. Long-Session `load()` latency in a real region (hundreds of parts × GET) — not measured; only the README's "grows linearly" statement exists.
