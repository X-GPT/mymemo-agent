# Token streaming via a Redis live lane (deferred)

Status: accepted (implementation deferred to its own increment)

Today the SSE stream is a projection of durably-recorded `run_events`: the
worker appends one `assistant_text` event per **complete assistant message**,
and chat-api's projector maps each to a `text_delta` frame. This is what
"wire the real SDK" ships — message-granularity, Postgres-only. It reads as
bursts of text (one per assistant message) rather than smooth token streaming.

Smooth token streaming is desirable but expensive under the current invariant:
because every client frame is a durable write, one `text_delta` per token would
mean hundreds of fenced `appendRunEventTx` + `NOTIFY` transactions per turn.
This ADR records the sanctioned target for reaching token-level streaming, so
the trade-offs are captured, without building it now.

**Target (two-tier):**

- The worker sets `includePartialMessages: true` and **publishes each partial
  text delta to a Redis pub/sub channel keyed per run** (`run:{runId}`). Each
  delta carries an assistant-message id, a zero-based `deltaIndex`, and its text
  and is exposed to the client as `text_delta`. The worker still appends the one
  **complete** `assistant_text` to Postgres at message end with the same message
  id; that durable event is exposed as `text_commit` containing the complete
  message text.
- `includePartialMessages` stays enabled after this hard cutover even when Redis
  is disabled or unavailable, because its envelope boundaries now define the
  durable Postgres commit unit. Redis configuration controls publication only;
  it never changes how assistant messages are grouped or persisted.
- One provider response envelope—from `stream_event.message_start` through its
  matching `stream_event.message_stop`—is one MyMemo assistant message and one
  commit unit. SDK `assistant` events are content-block-granular completion
  records inside that envelope, not message boundaries. All visible text blocks
  in the envelope share one continuous `deltaIndex` sequence; interleaved
  non-text blocks neither split the message nor advance that sequence. Because
  later raw stream events omit the provider envelope id, the assembler carries
  exactly one active envelope and content block in query-stream order and
  rejects overlapping boundaries.
- The envelope assembler uses the completed SDK `assistant` content-block events
  as the sole durable text source. At `message_stop` it concatenates their
  visible text in content-block order and appends that complete text as one
  `assistant_text` run event. Partial `stream_event` text is preview-only, and
  the terminal `result.result` echo remains ignored.
- At `message_stop`, the worker also compares the locally accumulated partial
  text with the completed-block aggregate exactly. A mismatch does not fail the
  run: the completed-block aggregate still commits and replaces the inaccurate
  preview, the worker records a payload-free mismatch metric, and live preview
  stays disabled for the rest of that run.
- `message_stop` is the only event that may commit an envelope. Cancel,
  ownership loss, shutdown, an SDK error result, or iterator rejection abandons
  the open assembler and ignores its late events; no accumulated partial or
  completed-block prefix is persisted. A clean iterator end with an open
  assembler, or a new `message_start` before the prior envelope stops, is a
  protocol violation that terminalizes the run as `error`.
- A valid envelope whose completed-block aggregate contains no visible text
  closes successfully without appending `assistant_text` or emitting
  `text_commit`. Its MyMemo message id remains internal; tool visibility belongs
  to the separate tool-event contract.
- The assistant-message id is an opaque MyMemo-generated UUID, unique within its
  run—not a Claude SDK/provider identifier. The worker creates it at
  `message_start`, persists it in the final `assistant_text` payload, and keeps
  the provider message id worker-internal for validating and grouping the
  ordered envelope.
- The worker coalesces tiny SDK text fragments per message for at most 50 ms
  before publishing one bounded `text_delta`; `deltaIndex` counts these
  published deltas, not raw SDK fragments. It flushes immediately at
  `message_stop`. This bounds transport overhead without adding
  perceptible typewriter latency.
- Redis carries only user-visible assistant `text_delta` frames. Tool arguments,
  tool results, thinking/reasoning blocks, and other SDK events use event types
  outside `text_delta` / `text_commit` and never enter this live lane. The
  current v1 projector does not expose those event families; defining them is a
  separate decision from this ADR.
- chat-api's SSE becomes a **merge** of (i) durable `run_events` for lifecycle
  and replay, and (ii) live Redis deltas for partial assistant text.
- On the original `user.message` path, chat-api generates the run id and
  establishes the Redis subscription before inserting the queued run, then
  buffers deltas until the SSE writer is ready. This guarantees capture from
  `deltaIndex: 0` when Redis is healthy. Subscription has a short timeout:
  failure still admits the run immediately onto the Postgres-only path, and a
  failed admission closes the unused subscription. Reconnects retain the weaker
  best-effort behavior below.
- Redis text is a **provisional live preview**, not committed transcript. Every
  open connection must converge in place to the exact complete
  `assistant_text` recorded in Postgres, including when it joins mid-message or
  Redis fails mid-message. The durable message therefore cannot simply be
  suppressed during live tailing: the client protocol must support a
  message-scoped `text_commit` operation that replaces all `text_delta`s for
  that message with the durable text.
- chat-api owns the **commit barrier** across the two transports. After it emits
  `text_commit` for a message id, it discards every later Redis `text_delta` for
  that message, even if cross-transport reordering delivers one. Clients may
  enforce the same rule defensively, but correctness does not depend on them.
- Every terminal frame discards any uncommitted preview. For `error` and
  `canceled`, this is the normal fate of an interrupted assistant message. A
  `done` with an uncommitted preview is an invariant violation that chat-api
  records before discarding it. Partial text is never retained in the live
  transcript when no corresponding durable event exists; preserving
  interrupted output would require a separate deliberate durable-event design.
- Pub/sub remains retention-free. chat-api forwards a message's live preview
  only while it observes a contiguous `deltaIndex` sequence beginning at zero.
  If a reconnect joins mid-message, or any delta is missed, it suppresses that
  message's remaining deltas and waits for `text_commit`; it never renders an
  incomplete suffix. Immediate reconstruction of an in-progress preview is not
  a reconnect guarantee.
- Redis `text_delta` frames carry no SSE `id:`. Only frames projected from
  durable `run_events` advance `Last-Event-ID` with their Postgres event
  sequence, including `text_commit`. The reconnect cursor therefore remains
  wholly durable and never names an ephemeral delta that cannot be replayed.
- Each SSE connection has a bounded live-preview buffer. If a slow client
  exhausts it, chat-api suppresses the affected message's remaining
  `text_delta`s and waits for `text_commit`; it never permits preview traffic to
  create an unbounded queue. Durable commits, lifecycle frames, and terminal
  outcomes take priority and are not dropped behind preview traffic, and the
  run itself is unaffected.
- The worker publishes through a bounded per-run queue; consuming the SDK stream
  never waits for Redis I/O. A full queue or publish failure abandons the live
  preview for that assistant message without failing or slowing its durable
  Postgres commit. Preview may resume at `deltaIndex: 0` for the next assistant
  message.
- Redis is **best-effort/additive**: if it is down, live streaming degrades to
  message-granularity from Postgres and the run never fails for it. **Postgres
  remains the single source of truth**, even though it is no longer the single
  source of *frames*.
- Redis is not a boot, readiness, or health dependency. A missing or invalid
  `REDIS_URL`, or a connection failure, disables the live lane and leaves both
  services on the Postgres-only path. The services emit payload-free degraded
  telemetry and alert on prolonged degradation, but remain healthy and continue
  processing runs.
- Live deltas have the same sensitivity as durable assistant output. Redis is
  reachable only by chat-api and agent-worker on the private trusted network,
  uses authenticated TLS, and has persistence (AOF and snapshots) disabled.
  Delta payloads are never logged; Redis credentials remain in the trusted
  services and are never passed into E2B.
- Pub/sub, not Redis Streams: the durable tier is Postgres, so the live lane
  needs no retention. (`NOTIFY` is unsuitable — 8 KB payload cap, not built for
  high-frequency token streams.)

## Considered Options

- **Message-granularity, Postgres-only** (ships now) — cheap, exact replay,
  bursty UX. The forward-compatible base: its durable write is exactly the
  complete-message tier the Redis design keeps, so shipping it wastes nothing.
- **Per-delta durable append** — rejected: 100s of transactions/turn; the
  baseline B that does not scale.
- **Delta batching in Postgres** (coalesce ~150 ms) — viable middle path;
  preserves "replay is the only SSE source." Not chosen because the product
  decision is a live Redis lane.
- **Redis live lane + Postgres complete-message** (chosen target) — best live
  UX, cheapest durable path; knowingly trades the single-frame-source invariant.
- **Commit each SDK `assistant` event** — rejected after the live SDK spike:
  those events are content-block-granular and arrive before the provider
  envelope's `message_stop`, so they cannot define an assistant-message commit.
- **Projector-side typewriter** — rejected: fake streaming; the worker only
  appends after the whole message completes, so it adds latency without
  real-time-ness.

## Validation

A live spike against pinned Claude Agent SDK `0.2.117` disproved the original
"one SDK assistant event is one message" assumption and established the
provider-envelope model above. A deterministic envelope-assembler prototype
then passed the replacement gate across five captured SDK shapes and seven
synthetic valid or malformed fixtures. It verified that the design can:

- replay the captured normal, tool, text-empty, cancellation, and SDK-error
  sequences from the live spike;
- process a synthetic valid envelope with multiple text blocks interleaved with
  a tool block;
- reject malformed fixtures with missing or overlapping boundaries and ignore
  late events after abandonment;
- commit exactly once and only at `message_stop`, concatenating completed
  visible blocks in content-block order;
- abandon incomplete envelopes without a durable text append; and
- prove that partial/complete mismatch preserves the completed-block commit,
  disables further preview for the run, and reports only payload-free telemetry.

The prototype also verified that the terminal result echo is ignored and that
an SDK error result followed by iterator rejection yields only one outcome. Its
scope was the ordered assembler state model—not Redis transport, database
writes, or production integration—so those remain implementation concerns for
the specification and its tests.

## Consequences

- New infrastructure: a Redis instance reachable by both services, optional
  `REDIS_URL` configuration in each, worker publish + chat-api subscribe, and
  the SSE merge.
- Knowingly breaks the "run-event replay is the only SSE source" exit criterion
  for the **live** path only; replay stays a pure projection. This is the
  accepted trade recorded here.
- This deliberately changes the client contract. In this increment,
  `text_delta` becomes the ephemeral partial text its name implies, while the
  new durable `text_commit` frame commits and replaces the deltas for its
  message. There are no active users to migrate, so clients and servers make a
  coordinated hard cutover: no legacy payload detection, dual emission, or
  compatibility window. The old meaning of `text_delta` as a complete durable
  assistant message is not preserved.
- Deferred: not part of "wire the real SDK." That increment ships the
  message-granularity base; this ADR and increment follow. The live
  partial-message spike and deterministic envelope-assembler gate are complete;
  production implementation must retain their cases as conformance tests.
