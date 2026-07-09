# Token streaming via a Redis live lane (deferred)

Status: proposed (deferred to its own increment)

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

- The worker sets `includePartialMessages: true` and **publishes each token
  delta to a Redis pub/sub channel keyed per run** (`run:{runId}`), while still
  appending the one **complete** `assistant_text` to Postgres at message end
  (the durable tier, unchanged from what ships now).
- chat-api's SSE becomes a **merge** of (i) durable `run_events` for lifecycle
  and replay, and (ii) live Redis deltas for token text.
- **Dual-source dedup rule:** the durable complete-message frame is **suppressed
  during live tailing** and emitted **only on replay/reconnect**. A live client
  renders Redis token deltas; a reconnecting/late client — for whom the
  ephemeral pub/sub deltas are already gone — replays the complete
  `assistant_text` from Postgres. Final text is identical either way.
- Redis is **best-effort/additive**: if it is down, live streaming degrades to
  message-granularity from Postgres and the run never fails for it. **Postgres
  remains the single source of truth**, even though it is no longer the single
  source of *frames*.
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
- **Projector-side typewriter** — rejected: fake streaming; the worker only
  appends after the whole message completes, so it adds latency without
  real-time-ness.

## Consequences

- New infrastructure: a Redis instance reachable by both services, `REDIS_URL`
  in each, worker publish + chat-api subscribe, and the SSE merge.
- Knowingly breaks the "run-event replay is the only SSE source" exit criterion
  for the **live** path only; replay stays a pure projection. This is the
  accepted trade recorded here.
- Deferred: not part of "wire the real SDK." That increment ships the
  message-granularity base; this ADR and increment follow. Proving
  `includePartialMessages`'s partial-message shape is that increment's spike
  (an s8 the SDK-runtime spike deliberately omits).
