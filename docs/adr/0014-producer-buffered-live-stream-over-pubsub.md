---
status: accepted
---

# Producer-buffered Live Stream over pub/sub

Status: accepted (2026-07-23); implemented by #369. Supersedes the
retained per-Run Redis Stream transport of
[ADR-0012](./0012-expose-a-full-ag-ui-agent-surface.md); every non-transport
decision there (admission, authorization, event vocabulary, Postgres-first
commit ordering, history, interruption) remains in force.

To simplify the live-transport adapter and remove Redis storage, MyMemo
replaces the retained per-Run Redis Stream with the pattern behind
`vercel/resumable-stream`: **the producer's memory is the store; Redis is only
a relay**. The claiming worker buffers each Run's serialized AG-UI events in
its own heap and publishes each event once over pub/sub; no stream content is
ever stored in Redis. Per-token Redis command traffic is unchanged — in the
split runtime chat-api is always a listener, so every event crosses Redis
either way — the savings are stored bytes and the adapter machinery (the
`ResumableStreamStore` contract, its Lua scripts, and TTL/cap/trim management).

## Decision

- **Discovery plane is Postgres, not a sentinel key.** `runs.status`, the
  ownership lease, and `live_stream_failed_at` already answer "is there
  anything to resume?" authoritatively. A reader that finds the Run terminal
  goes straight to Conversation history and never touches pub/sub. The
  reference design's 24-hour sentinel key has no job here and is not ported.
- **Data plane: one shared per-Run live channel plus a per-reader reply
  channel.** The producer publishes each event exactly once to the Run's live
  channel, stamped with an internal ordinal. A reader subscribes to the live
  channel first, buffers arriving events, then requests the backlog on the
  producer's per-Run request channel with a private reply channel; the reply
  carries the full backlog and the count of events it covers, and the reader
  discards buffered live events below that count. The seam is gapless by
  arithmetic, not by single-block synchronicity; there is no listener
  registry, no per-listener fan-out, and nothing to prune.
- **No cursors on the wire.** SSE `id`s, `Last-Event-ID` handling, and
  `activeRun.lastEventId` are removed. Every attach — original POST, transient
  reconnect, full refresh — rebuilds the active Run from the full backlog
  through the client's existing from-zero rebuild path. Internal ordinals
  never leave the transport.
- **Reader retry is Postgres-governed.** chat-api re-requests the backlog with
  backoff while the Run is active and unfailed, holding the SSE open with the
  existing comment pings (the queued-Run wait is unchanged). It stops when a
  producer answers, the Run terminalizes (serve history), or
  `live_stream_failed_at` is set (`410`). The reference design's one-shot
  1000 ms timeout — which conflates a dead producer with a busy one — is not
  ported; a dead producer's Run is terminalized by stale-Run recovery, which
  ends the loop.
- **Terminal means history.** The worker publishes the terminal event to the
  live channel only after its Postgres commit (ordering rule unchanged), then
  closes the request channel and frees the buffer. The 30-minute post-terminal
  replay window is removed: a reader arriving after the Outcome always
  hydrates permanent history. This structurally removes the reference
  design's done-races (its issues #44 and #47): a reader that blips at the
  terminal instant retries, observes the terminal status in Postgres, and
  recovers.
- **Failure contract and bounds carry over unchanged.** Sequential
  bounded-timeout publishes in SDK event order; the first publish failure sets
  `live_stream_failed_at`, disables later publishes for that Run, and never
  fails the Run. `503` before the first event, `410` on the failure marker,
  and the Reconnecting/Recovering client states are word-for-word the same.
  The 10,000-event / 8 MiB per-Run caps now bound the producer's buffer
  (crossing one follows the live-failure path while the Run continues), and
  the 32 KiB per-event / 16 KiB text-coalescing caps remain. `REDIS_URL`
  stays required, authenticated `rediss://`, validated at startup.
- **Accepted durability loss: the backlog dies with the producer.** If a
  worker dies mid-Run, a newly attaching reader gets no backlog during the
  stale window — it retries silently until stale-Run recovery terminalizes the
  Run, then recovers from history with no partial Assistant text. An
  already-connected client keeps what it received. The window is bounded by
  the existing heartbeat/lease/recovery machinery and affects only
  provisional content on a Run that is terminalizing abnormally. This is the
  essential price of removing the store.
- **Bespoke implementation.** The `vercel/resumable-stream` package is not
  used: its chunks are plain strings with character-count skip, its producer
  is the HTTP handler that owns the client response, and its lifetime is
  `waitUntil`-pinned — all three contradict the split runtime. The
  `assistant-stream/resumable` `ResumableStreamStore` contract and the Lua
  Redis adapter are dropped with the retained Stream.
- **Sequencing: after #344.** The legacy events-path transport and two-source
  projector are deleted first, leaving one transport; then that transport is
  swapped. No tri-transport state ever exists.

## Considered Options

- **Diet the retained-Stream adapter** — keep Streams and cursors, cut the
  post-terminal retention and cap machinery. Recommended for lowest risk;
  rejected by product decision in favor of removing stored stream state
  entirely.
- **Pub/sub live plus Postgres-projection replay** — rejected: resurrects the
  two-source merge projector that ADR-0012 deliberately killed.
- **Per-listener mailbox fan-out (faithful port)** — rejected: O(listeners)
  publishes per event, an unprunable listener registry, and a seam whose
  correctness depends on never inserting an `await` into one synchronous
  block.
- **Event-ordinal cursors on the wire** — rejected for maximal wire-contract
  simplification; every reconnect rebuilds from the full backlog instead.

## Consequences

- The client contract changes: no resume cursor exists, and reconnection is
  always a full rebuild of the active Run. `mymemo-web`'s transient-reconnect
  path collapses into its full-refresh path.
- A transient blip mid-Run re-streams the whole backlog (bounded by the 8 MiB
  cap) instead of a suffix.
- ADR-0012's resumability verification matrix is re-targeted: replay-from-zero
  and after-cursor tests are replaced by backlog/live seam dedupe, retry-until-
  terminal, queued-Run wait, producer-death recovery, terminal-instant races,
  and buffer-cap tests against real Redis pub/sub plus Postgres.
- Redis holds no per-Run keys at all; observability shifts from Stream
  acquisition/TTL metrics to backlog-request latency, retry counts, and
  publish-failure rates.
