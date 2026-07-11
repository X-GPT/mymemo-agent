# Token streaming via a Redis live lane

Status: accepted (2026-07-10); durable-message increment implemented first

## Decision

Assistant text uses two tiers with different authority:

- Postgres stores one `assistant_text` Run event per complete, non-empty
  Assistant message. Its payload is `{ messageId, text }`.
- chat-api projects that durable event as `text_commit`. The frame carries the
  Run-event sequence as its SSE cursor and is the only replayable text.
- A later increment may publish provisional `text_delta` frames through
  best-effort Redis Pub/Sub. Those frames are cursorless and never outrank the
  matching durable commit.

The worker always sets `includePartialMessages: true`, including when Redis is
disabled, because provider stream envelopes define the durable message unit.
One MyMemo Assistant message opens on provider `message_start`, receives one
opaque MyMemo `messageId`, aggregates completed SDK content blocks belonging to
that provider message, and commits only after the matching `message_stop`.
Terminal result text is an echo and is never another content source.

Completed SDK content blocks are the durable text source. Partial visible text
is retained only as preview evidence. If partial and complete text disagree,
the complete text commits, payload-free telemetry records the mismatch, and
Live preview stays disabled for the remainder of the Run.

Cancellation, ownership loss, shutdown, SDK failure, provider rejection,
iterator rejection, or an incomplete/malformed envelope abandons the open
message. A nominally successful stream with invalid envelope structure fails
the Run closed; it never manufactures a partial durable message.

## Client reconciliation

`text_delta` is provisional and contains `{ messageId, deltaIndex, text }`.
`text_commit` is authoritative and contains `{ messageId, text }`. A client
appends contiguous deltas to a provisional message and atomically replaces it
when the matching commit arrives. A commit without preview creates the message;
late deltas cannot resurrect it. Terminal outcomes clear uncommitted previews.

## Projector module boundary

`projectRun` remains one deep module that owns durable polling, the prepared
Live subscription lifecycle, per-message reconciliation, and two-source wake-up
arbitration behind one client-stream interface. Those concerns jointly enforce
one ordering and authority contract for one caller. Extracting a one-caller Live
helper now would expose a shallow internal interface without a second adapter or
reuse point; revisit the seam only if another projection policy or transport
adapter needs the same reconciliation behavior.

## Availability and security

Redis is additive. Missing configuration, connection or publish failure,
backpressure, and dropped preview degrade to Postgres message-granularity
delivery without failing service health or the Run. Redis has no retention;
Postgres remains the transcript and replay source of truth.

Only user-visible Assistant text may enter the live lane. Tool input/output,
reasoning, credentials, and provider internals remain excluded. Redis is
trusted-plane-only, authenticated, encrypted in transit, and never exposed to
the E2B sandbox.

## Rejected alternatives

- Per-delta durable appends: hundreds of fenced transactions per response.
- Redis Streams: duplicates retention already owned by Postgres.
- Projector-side typewriter animation: not real model progress.
- Legacy `text_delta` compatibility or historical payload backfill: this is a
  coordinated hard cutover with no active users to migrate.
