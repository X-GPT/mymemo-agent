# Durable Obligations Inside `agent-stream.ts` — Inventory

**Verified on 2026-08-14**, against commit `5393943` (`5393943 feat(agentcore): execute
detached canary runtime (#460)`) on `main`. Every line reference below is to that commit.
Primary sources are this repo's code and `docs/adr/`; no external claim is made here.

Research ticket: [#464](https://github.com/X-GPT/mymemo-agent/issues/464). Map:
[#462](https://github.com/X-GPT/mymemo-agent/issues/462) — whether the AgentCore canary lane
can **wrap** `@ag-ui/claude-agent-sdk` rather than fork it.

---

## The question this answers

`apps/agent-worker/src/sdk/agent-stream.ts` is 697 lines. Only a minority of them map SDK
messages to AG-UI events. The rest are durable obligations. For a wrap to be possible, each
obligation must be answerable as either:

- **Outside** — it can live in code that consumes the adapter's event stream, or that runs
  before/after the stream, without the adapter knowing.
- **Inside** — it requires a hook *between event formation and publication*: something must
  happen to Postgres, to the query handle, or to the message *before* the corresponding AG-UI
  event reaches a consumer, and the adapter's own emission would already be wrong or too late.

**Verdict up front: 28 of 33 obligations require an inside hook.** They are not incidental —
they implement the load-bearing rule of ADR-0012/0014 ("commit to Postgres, then publish") and
the fail-closed stop protocol of ADR-0013. The single most consequential finding is that
**the adapter's `run(input)` Observable is the wrong granularity by construction**: MyMemo's
publication of `TEXT_MESSAGE_END`, `TOOL_CALL_*`, `TOOL_CALL_RESULT` and
`CUSTOM mymemo.generative_ui` is *causally downstream of a database transaction whose assigned
sequence number is embedded in one of those events*. An Observable that has already emitted
them cannot be retrofitted with that ordering by a downstream operator.

---

## Master table

| # | Responsibility | Lines (`agent-stream.ts` unless noted) | ADR | Inside hook required |
|---|---|---|---|---|
| A1 | Assistant completion commits before `TEXT_MESSAGE_END` publishes | 570–581 | 0012, 0014 | **Yes** |
| A2 | Tool lifecycle triple commits before its three AG-UI events publish | 310–344 | 0012 | **Yes** |
| A3 | Tool result commits before `TOOL_CALL_RESULT` publishes | 392–409 | 0012 | **Yes** |
| A4 | `ui_payload` events commit atomically *with* their Assistant message | 274–294 | 0017 | **Yes** |
| A5 | Published `mymemo.generative_ui` carries the DB-assigned durable sequence | 294–308 | 0017 | **Yes** |
| A6 | Tool triple is one transaction (start/args/completed never split) | 312–329; `run-store.ts:582` | 0012 | **Yes** |
| A7 | Durable emission order: text → tool uses in block order → results in block order | 282–349, 352–418 | 0009, 0012 | **Yes** |
| B1 | No content appended after a stop is requested (pre- *and* post-await recheck) | 201–214, 537 | 0013 | **Yes** |
| B2 | Bounded stop: `interrupt()` once, 30 s deadline, then `close()` | 66, 448–483 | 0013 | **Yes** |
| B3 | Ownership loss / shutdown / renewal failure force-close *without* the grace window | 118–124, 465–500 | 0013, 0015 | **Yes** |
| B4 | Force-close wins a race against a hung iterator; late rejection is not lost | 502–526 | 0013 | **Yes** |
| B5 | On `mirror_error`, Run-scoped Tool/E2B work aborts *before* the SDK interrupt | 531–536 | 0005, 0013 | **Yes** |
| B6 | An open Assistant message is abandoned, never completed, on stop/failure | 184–188, 488–492, 595 | 0008, 0012 | **Yes** |
| B7 | Only a neutral `completed`/`stopped`/`failed` disposition is reported; no cause inference | 97–113, 585–600 | 0013 | No |
| B8 | A stopped in-flight append settles as `stopped`, not `failed` | 52–57, 590–593 | 0013 | **Yes** |
| C1 | `mirror_error` observed and reported as `mirrorErrorObserved` | 85–90, 531–536 | 0005 | **Yes** |
| C2 | After `mirror_error`, raw stream error detail is withheld from logs | 436–447 | 0005 | **Yes** |
| C3 | Resumable main-session id sourced from the bound `SessionStore`, not the stream | `run-processor.ts:82–83` | 0005 | No |
| D1 | Tool-name allowlist gate before any append | 248–255; `tool-event-projection.ts:63–86` | 0009, 0012 | **Yes** |
| D2 | Bounded per-tool projection, 16 KiB cap, omit-and-log on shape surprise | 257–266, 374–387 | 0009 | **Yes** |
| D3 | `PresentUI` excluded from Tool projection on *both* the use and the result | 200, 226–227, 356–358 | 0017 | **Yes** |
| D4 | `ui_payload` validated before persist; invalid payload never persisted | 229–240 | 0017 | **Yes** |
| D5 | Error results flatten to fixed text plus a live `mymemo.tool_result_error` | 389–391, 410–416 | 0009, 0012 | **Yes** |
| D6 | Replay-flagged SDK user messages create no Tool events | 547–554, 660–666 | 0009 | **Yes** |
| D7 | Provider tool-use ids stay worker-internal; MyMemo UUID is the public identity | 196–199, 311, 345–348 | 0012 | **Yes** |
| D8 | One result per invocation; correlation never fabricated | 356–373 | 0009, 0012 | **Yes** |
| E1 | Envelope protocol violations fail the Run closed rather than ending `done` | 555–583; `assistant-message-assembler.ts:339–342` | 0008 | **Yes** |
| E2 | Provisional live text must match the committed text | 178–183, 565–569 | 0008 | **Yes** |
| E3 | An `is_error` terminal `result`, or an errored assistant message, is a failure not a success | 68–83, 538–546 | 0008 | **Yes** |
| E4 | A clean stream end with an open envelope fails closed | 587; assembler `160–164` | 0008 | **Yes** |
| F1 | Text coalescing, bounded backpressure, drain-before-commit | `ag-ui-text-stream.ts` (whole); 570 | 0012, 0014 | Partly |
| F2 | Live-lane failure never changes the model Outcome | 131–133; `run-live-stream.ts:69–78` | 0012, 0014 | No |
| F3 | No `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` / `RUN_INTERRUPTED` is emitted here | absent by design; `run-live-stream.ts:58–62, 81–114` | 0013, 0014 | No (but see §6) |

Counting the master rows: 33 distinct responsibilities — **28 require an inside hook**, 1 is
partly inside (F1), and 4 sit cleanly outside (B7, C3, F2, F3).

---

## 1. Commit-before-publish (A1–A7)

This is the single obligation the map calls the "central risk", and it is not one rule but
seven distinct enforcement points.

**The governing line**, ADR-0012:

> "Publishing `TEXT_MESSAGE_END`, a Tool result, or a terminal event before its Postgres
> commit is forbidden because a client could otherwise observe completed state that permanent
> history does not contain."

ADR-0014 carries it forward verbatim in scope: "The worker publishes the terminal event to the
live channel only after its Postgres commit (ordering rule unchanged)."

### A1 — Assistant completion (`agent-stream.ts:570–581`)

```
const liveMessageId = await agUiText.flushMessage();
await commitEnvelope(assembled.commit);
if (assembled.commit.text !== null && liveMessageId === ...) {
    await appendLiveEvent({ type: EventType.TEXT_MESSAGE_END, messageId: liveMessageId });
}
```

Three ordered steps: drain every outstanding `TEXT_MESSAGE_CONTENT`, commit, *then* end the
message. ADR-0012: "the worker first appends one `assistant_message_completed {messageId,
text}` Run event to Postgres and only then appends `TEXT_MESSAGE_END` to Redis."

**Inside: yes.** An adapter that emits `TEXT_MESSAGE_END` as part of its message-stop mapping
has already published it. A downstream operator can delay the event, but it cannot delay the
*commit* it must follow, because the commit's input (`commit.text`, `commit.toolUses`, the
MyMemo `messageId`) is the assembled envelope, not the AG-UI event. Reordering after the fact
would mean reconstructing the durable payload from the emitted events — which is precisely the
"two-source projector" ADR-0012 killed (§ line 28).

### A2/A3/A6 — Tool lifecycle and results (`310–344`, `392–409`, `312–329`)

Each projected `tool_use` writes `tool_call_started` + `tool_call_args` +
`tool_call_completed` as **one** `appendModelContents` batch, then publishes
`TOOL_CALL_START` / `TOOL_CALL_ARGS` / `TOOL_CALL_END`. The batch atomicity is enforced in the
shared data layer (`packages/agent-db/src/run-store.ts:577–581`):

> "Append a non-empty ordered batch under one Run-row fence and transaction. A complete Tool
> invocation uses this so start/arguments/completion can never be split by interruption,
> ownership loss, or a database failure."

ADR-0012: "Each lifecycle event is appended to the Redis Stream only after its Postgres
commit, so Tool activity remains permanent while the active client consumes one ordered live
transport."

**Inside: yes**, for the same reason as A1, and additionally because the *batch grouping* is
invisible at the AG-UI level — three AG-UI events correspond to one transaction, and nothing
downstream can recover that grouping.

### A4/A5 — `ui_payload` atomicity and durable event id (`274–308`)

The Assistant message and every validated `ui_payload` for that envelope go into a **single**
`appendModelContents` call (`282–294`). The returned sequence array is then indexed
(`sequences[index + 1]`) to stamp each published CUSTOM event:

```
eventId: `${params.runId}:${sequence}`
```

ADR-0017: "Delivery is **commit-only**: validate → commit → publish whole, under the same
commit-before-publish rule as every other event" and "whose value is the event payload plus
the durable event id."

**Inside: yes, and this is the strongest single case in the inventory.** The published
event's `eventId` is a value *assigned by the database transaction*. There is no ordering
trick, no buffering operator, no post-hoc decoration that can inject a Postgres-assigned
sequence into an event the adapter has already formed and emitted. Any adapter that owns
emission of this event must expose a hook that runs between formation and publication and can
mutate the event — or MyMemo must suppress the adapter's emission entirely and synthesize this
event itself.

The tests pin both directions of the race:
`agent-stream.test.ts:1605` ("drops a validated PresentUI call when stop arrives before
envelope commit") and `:1639` ("retains an atomically committed PresentUI payload when stop
wins before publication"). Durable state, not the live event, is the arbiter.

### A7 — Durable emission order

Within one envelope: Assistant message (+ its `ui_payload` events) first, then tool uses in
content-block order (`282–349`); results follow in tool-result block order (`352–418`).
ADR-0009: "At one assistant envelope's `message_stop`, its single `assistant_text` /
`text_commit` is appended first when it has visible text, followed by its `tool_use` events in
tool-block order."

This is not merely stylistic: `packages/agent-db/src/run-events.ts:247` runs
`validateDurableRunEventSequence` inside the append transaction and **rejects** a batch that
violates the grammar (`started → args → completed → result`, unique `toolCallId`, unique
`messageId`, no event after a terminal Outcome). A projection that appended tool events before
their parent Assistant message would be rejected by the database, failing the Run.

**Inside: yes.** The order in which durable rows are written is decided at the same point the
events are formed.

---

## 2. Stop protocol (B1–B8)

### B1 — The stop gate, twice (`201–214`, `537`)

```
if (stopRequested) throw new QueryStoppedError();
const sequences = await appendModelContents(contents);
// The append itself is not abortable. Recheck after it settles so shutdown
// cannot let the rest of the envelope append while the DB Run is still fenced as running.
if (stopRequested) throw new QueryStoppedError();
```

Plus the message-level gate at `537` (`if (stopRequested) continue;`). ADR-0013: "the moment
the run is aborted … any further content is ignored — never appended" (the file's own
docstring, `162–165`) and, from the ADR, "Recording an interruption closes durable
user-visible model-content appends and Downloadable artifact publication immediately".

**Inside: yes.** The post-await recheck exists specifically because a *durable write* can
straddle a stop. Only code that owns the write can perform it.

### B2/B3/B4 — Bounded stop, force-close classes, and the hung-iterator race (`448–526`)

ADR-0013 is explicit and quantified:

> "After observing `interrupt_requested`, the owner calls `Query.interrupt()` and allows at
> most 30 seconds for a clean SDK stop. If it does not settle, the worker calls
> `Query.close()` to terminate the underlying CLI process and resources, records the forced
> close internally, and still commits the already-accepted `interrupted` Outcome if its
> ownership fence still passes."

`QUERY_STOP_TIMEOUT_MS = 30_000` at line 66. `stop()` (448–464) interrupts once, arms the
deadline, and escalates to `forceClose()`. Three *different* signal classes are wired at
`493–500`:

- `interruptionSignal` → `stop()` (graceful, 30 s window)
- `ownershipLostSignal` → `forceClose()` immediately. The comment at `122–124` states the
  invariant: "Fires only after the ownership fence is gone; close immediately because no
  private transcript drain is permitted beyond the lease."
- `forceCloseSignals` — runtime shutdown plus the query-local signal
  (`run-processor.ts:71–74`), which `start-run-query.ts:225` binds to sandbox-renewal failure.

The `Promise.race` at `504–526` lets a force-close win against an iterator that never returns,
while still attaching a catch handler so a late rejection is retained in worker-only
diagnostics rather than becoming an unhandled rejection.

**Inside: yes, all three.** These operate on the SDK `Query` handle — `interrupt()`,
`close()`, and the raw async iterator. The map records that `ClaudeAgentAdapter` "handles
message extraction, option building, and SDK querying internally", i.e. it *owns* the handle.
Unless the adapter exposes the handle or an equivalent typed stop API with these three
distinct semantics, this cannot be wrapped. Note that RxJS `unsubscribe()` is not a
substitute: it detaches the consumer, it does not carry a 30-second grace window, an
escalation to process termination, or a distinction between graceful and immediate stop.

### B5 — Abort Run-scoped work *before* the cause-blind interrupt (`531–536`)

```
if (isMirrorError(message)) {
    outcome.mirrorErrorObserved = true;
    params.abortRunScopedWork(new Error("agent session mirror failed"));
    stop();
    continue;
}
```

ADR-0013: "on the SDK's `mirror_error` stream message, the processor aborts the Run-scoped
controller that cancels active Tool/E2B work and invokes `Query.interrupt()` to stop model
execution."

**Inside: yes.** This is a side effect triggered by observing one specific SDK message,
ordered *before* a control call on the query. `mirror_error` is an SDK `system` message
subtype with no AG-UI representation — an adapter that maps SDK messages to AG-UI events has
no obligation to surface it at all, and if it drops it, MyMemo loses the trigger entirely.
This is the clearest example of a message MyMemo needs that the AG-UI vocabulary does not
contain.

### B6 — Abandon, never complete (`184–188`, `488–492`, `595`)

`abandonOpenMessage()` clears the assembler and the live text stream without publishing
`TEXT_MESSAGE_END`. ADR-0012: "If a Run fails or is interrupted with an open Assistant
response, its incomplete text remains provisional … and is not copied into permanent history",
and ADR-0008: "`message_stop` is the only event that may commit an envelope. Run interruption,
ownership loss, shutdown, an SDK error result, or iterator rejection abandons the open
assembler and ignores its late events."

**Inside: yes.** Suppressing a fabricated completion requires knowing that no completion was
formed — buffered adapter output would have to be inspected and selectively dropped, which is
strictly harder than not emitting it.

### B7 — Neutral disposition (`97–113`, `585–600`)

`consumeAgentStream` returns `completed` / `stopped` / `failed` and never names a cause.
ADR-0013: "The stream processor reports only a neutral `stopped` disposition plus mirror
reliability; it does not receive or infer a domain stop cause. The Run supervisor reconciles
its local abort state with the durable Run status and alone maps a durable user interruption
to `interrupted`."

**Inside: no.** This is a boundary *discipline*, and the Outcome decision already lives
outside, in `run-serving.ts:507–568`. A wrapper can compute the disposition from an observed
Observable completion/error plus its own stop bookkeeping.

### B8 — Stopped appends settle as `stopped` (`52–57`, `590–593`)

`QueryStoppedError` is internal control flow, converted to the same neutral `stopped`
disposition as a quiet stream end, so an in-flight append interrupted by shutdown does not
become an `error` Outcome.

**Inside: yes** — it is thrown from within the durable-append path (B1) and must be
distinguished from a genuine failure at the point it is caught.

---

## 3. Mirror reliability (C1–C3)

ADR-0005: "A `mirror_error` is fatal rather than best-effort: it stops model and Tool
execution and makes a still-running Run end as `error`. A user interruption already committed
in Postgres still wins and ends as `interrupted`. A mirror error cannot establish a first
pointer."

**Correction to the ticket's framing.** The ticket lists "mirror fail-fast" and
"mirror-reliability reporting" as things `agent-stream.ts` does. Precisely:

- `agent-stream.ts` **observes** `mirror_error` and **acts** (abort + stop), and **reports**
  `mirrorErrorObserved: boolean` (C1, inside).
- `agent-stream.ts` does **not** decide the Outcome. `run-serving.ts:532–550` does, and the
  ordering there is load-bearing: `interrupted` is checked *before* `mirrorErrorObserved`,
  which is why the ADR's "interruption wins" holds. Outside.
- `agent-stream.ts` does **not** produce `mirroredMainSessionId`. That comes from the bound
  `SessionStore` adapter (`sdk/session-store.ts:84–86, 135–137`) and is read in
  `run-processor.ts:82–83`. Outside (C3). It is suppressed when
  `mirrorErrorObserved` is true, in `run-serving.ts:727–740`.

### C2 — Redaction after a mirror failure (`436–447`)

```
// A late drain failure after mirror_error may repeat the SDK's raw
// provider/transcript detail. The observed failure is monotonic, so
// neither a prior interruption nor a later operational close can re-enable that detail.
...(outcome.mirrorErrorObserved ? {} : { error: toMessage(error) }),
```

A telemetry-privacy obligation: transcript-bearing detail must not reach worker logs once the
mirror has failed. ADR-0012's observability rule is the general form: logs "must never contain
serialized AG-UI events, Assistant text, Tool arguments or results". Note the deliberate
asymmetry with `forceClose()`'s own catch (`470–479`), which *always* logs, because
`close()` is a worker-side cleanup boundary rather than provider payload. Tests pin both
(`agent-stream.test.ts:955`, `:1030`).

**Inside: yes** — the decision needs `mirrorErrorObserved` at the moment the error is logged,
inside the consumption loop's catch boundaries.

---

## 4. Content safety (D1–D8)

ADR-0009: "Projection is explicit per tool, never a pass-through of SDK input, executor
output, document audit rows, or transcript entries."

This is where a naive wrap is most obviously unsafe. The adapter's job is to project SDK tool
calls into `TOOL_CALL_ARGS`; MyMemo's rule is that raw model-authored tool input **must never
reach a client**. `tool-event-projection.ts` (1051 lines) re-projects every field defensively,
per tool, under named byte budgets, and returns `{ok:false, reason}` when the shape surprises
it. Only nine executor tool names are allowlisted (`tool-event-projection.ts:63–74`).

- **D1** (`248–255`): a non-allowlisted name is logged and omitted. ADR-0009: "Unknown,
  built-in or permission-denied tool names are logged and omitted."
- **D2** (`257–266`, `374–387`): an unprojectable payload is omitted, not truncated,
  under a 16 KiB post-projection cap (`TOOL_EVENT_MAX_JSON_BYTES`). ADR-0009: "Each event is
  capped at 16 KiB of UTF-8 JSON after projection and is never split across frames."
- **D3** (`200`, `226–227`, `356–358`): `PresentUI` is excluded twice — the invocation never
  becomes a `tool_call_*`, and its result is swallowed by the `presentUiUseIds` set so it also
  never becomes an orphan-result warning. ADR-0017: "The `PresentUI` call is **excluded from
  tool-event projection**: no `tool_call_*` events, no ack projection; the `ui_payload` event
  is its only record, because client-side the payload is content, not tool activity."
- **D4** (`229–240`): validation precedes persistence. ADR-0017: "An invalid payload is
  **never persisted**: no invalid content ever reaches a client, and there are no truncation
  semantics — an over-cap payload is rejected whole, never clipped." The failure log itself is
  payload-free: only rule, component name, and byte counts (`231–238`).
- **D5** (`389–391`, `410–416`): `isError` results collapse to the literal string
  `"Tool failed"`, and the live-only `CUSTOM mymemo.tool_result_error` follows. ADR-0012:
  "A recoverable Tool error therefore emits the standard result with its fixed client-safe
  error text, immediately followed by `CUSTOM {name: "mymemo.tool_result_error", ...}`."
- **D6** (`547–554`, `660–666`): `isReplay: true` user messages are skipped whole. ADR-0009:
  "SDK user messages with `isReplay: true` never create tool events." Without this, every
  resumed turn would re-emit the previous turn's tool activity into the new Run's history.
- **D7** (`196–199`, `311`, `345–348`): the provider `tool_use.id` indexes a map that never
  leaves the worker; the client sees a fresh `randomUUID()`. ADR-0012: "Each client-visible
  Tool invocation receives a stable, opaque, MyMemo-generated UUID exposed as `toolCallId`;
  the worker maps the provider's Tool-use id to it only for internal correlation."
- **D8** (`356–373`): the map entry is deleted on first match, so a second result for the same
  id is logged and omitted. The file's own words: "correlation is never fabricated" (`157`).

**Inside: yes for all eight.** Every one of them is a gate that must fire *before* both the
durable append and the live publish. D7 in particular means the adapter's own `toolCallId` —
whatever it derives from the provider id — must never be published, so its `TOOL_CALL_*`
events cannot be forwarded as-is even if the ordering problem were solved.

---

## 5. Fail-closed protocol validation (E1–E4)

`assistant-message-assembler.ts` is a strict state machine over the SDK stream: contiguous
block indices, no overlapping envelopes, one `message_delta`, a per-block-type allowlist of
delta subtypes (`KNOWN_BLOCK_DELTA_TYPES`, `77–96`), and `#violation()` throwing
`AssistantEnvelopeProtocolError` (`339–342`). ADR-0008: "`message_stop` is the only event
that may commit an envelope … A clean iterator end with an open [envelope]" fails.

- **E1**: a violation propagates out of `consumeAgentStream` as `disposition: "failed"`, so
  the Run ends `error` rather than `done`. Tests: `agent-stream.test.ts:677, 740`.
- **E2** (`178–183`, `565–569`): if the accumulated provisional text does not equal the
  completed-block aggregate, the Run fails closed. **This diverges from ADR-0008's literal
  text**, which says the mismatch "does not fail the run: the completed-block aggregate still
  commits and replaces the inaccurate preview, the worker records a payload-free mismatch
  metric, and live preview stays disabled for the rest of that run." The current code throws
  instead. ADR-0012 supersedes ADR-0008's "message-reconciliation policy", but that clause
  reads as chat-api's two-transport merge, not the worker's own compare — so the divergence
  looks real rather than superseded. Corroborating evidence: the assembler still carries the
  ADR-0008 behaviour as vestigial dead code — `#livePreviewEnabled` is set to `false` on
  mismatch (`assistant-message-assembler.ts:307`) and exposed via a getter (`116–117`) that
  **nothing in the worker reads**; the live path instead goes through the throwing
  `onPartialCompleteMismatch` callback. Ticket 4's ADR should either ratify the stricter
  behaviour or restore ADR-0008's, and the dead getter should go with it.
- **E3** (`68–83`, `538–546`): `resultErrorText()` extracts failure text from a terminal
  `result` message with `is_error: true`, and an `assistant` message carrying `error` becomes
  `AgentResultError`. The docstring is the invariant: "The SDK reports a run failure either by
  throwing or — on a clean process exit — by emitting a terminal `result` message with
  `is_error: true`. This extracts the failure text from the latter so it is not mistaken for
  success."
- **E4** (`587`): `assembler.finish()` after a clean loop exit throws if an envelope is still
  open.

**Inside: yes for all four.** E3 is the sharpest for the wrap question: an adapter mapping the
terminal `result` message would plausibly emit `RUN_FINISHED`. MyMemo must instead treat that
exact message as a Run failure. A downstream consumer that only sees `RUN_FINISHED` has lost
the `is_error` bit and the failure text.

---

## 6. Live-lane mechanics (F1–F3)

- **F1 — coalescing and backpressure** (`ag-ui-text-stream.ts`, whole file). 50 ms coalescing
  window, 16 KiB pending cap, at most one in-flight publish, strict order. ADR-0014: "the
  32 KiB per-event / 16 KiB text-coalescing caps remain"; ADR-0012: "The worker awaits each
  Stream append sequentially in SDK event order … there is no asynchronous publication queue."
  **Partly inside.** Coalescing itself is a pure stream transform and could sit outside. The
  *drain barrier* — `flushMessage()` must complete before `commitEnvelope()`, which must
  complete before `TEXT_MESSAGE_END` — cannot (that is A1).
- **F2 — live failure is absorbed** (`131–133`; `run-live-stream.ts:69–78`). The bound
  producer catches, disables itself, and persists `live_stream_failed_at`; the model Outcome
  is untouched. ADR-0012: "Redis availability does not determine the Run Outcome."
  **Outside** — already is.
- **F3 — no Run-level events here.** `agent-stream.ts` emits only `TEXT_MESSAGE_*`,
  `TOOL_CALL_*`, and the two `CUSTOM` events. `RUN_STARTED` is published when the producer
  opens (`run-live-stream.ts:58–62`) and the terminal event only after the Postgres terminal
  transaction commits (`run-serving.ts:456–457` → `run-live-stream.ts:81–114`), including the
  bespoke `RUN_INTERRUPTED` extension that ADR-0013 pins as
  `{ type: "RUN_INTERRUPTED", threadId, runId }`.

  **Outside in principle, but a hard constraint on a wrap.** An adapter's `run()` Observable
  almost certainly emits `RUN_STARTED` / `RUN_FINISHED` / `RUN_ERROR` — that is the AG-UI
  contract for a run. MyMemo must **suppress all four** and re-derive them from Postgres and
  the relay lifecycle, or clients would observe a `RUN_FINISHED` that permanent history
  contradicts. Filtering is easy; the point is that it is mandatory and easy to forget.

---

## 7. What is *not* in this file (boundary map)

Useful for scoping tickets 3 and 4 — these ADRs touch the SDK lane but are enforced elsewhere,
so they do not constrain the adapter:

| Concern | ADR | Where it actually lives |
|---|---|---|
| Fail-closed query options, tool allowlist, no settings sources, pinned CLI | 0006 | `sdk/start-run-query.ts`, `sdk/run-tools.ts` |
| Documents-as-files, reserved docs cache | 0004 | `documents/`, `sdk/run-tools.ts` |
| Conversation-stable cwd stabilizing `projectKey`; resume pointer | 0005 | `sdk/session-store.ts:46–48, 159–173` |
| Ownership fence on every durable write (epoch + lease) | 0015 | `packages/agent-db/src/run-store.ts` (`liveConversationOwnershipExists`) |
| Terminal Outcome selection, interruption-wins, artifact publication | 0013, 0011 | `run-serving.ts:507–568` |
| Claim, snapshot ordering, Reclamation, release | 0015, 0023 | `run-loop.ts` (Fargate only) |
| Sandbox renewal failure → force close | 0007 | `sdk/sandbox-renewal.ts`, `start-run-query.ts:479–496` |

Note the existing wrap precedent: `start-run-query.ts:448–498` already **decorates the SDK
`Query` handle** — it re-exports `interrupt()`/`close()`, adds `forceCloseSignal`, and wraps
the async iterator to convert an opaque `AbortError` into a `SandboxRenewalError` and to run
teardown in a `finally`. If an adapter owns `query()` internally, that decoration seam
disappears too, and sandbox-renewal failure loses its diagnostic identity.

---

## 8. Verification notes on the ticket's starting list

| Ticket item | Verdict |
|---|---|
| Commit ordering (ADR-0014) | **Confirmed.** Seven distinct enforcement points (A1–A7), not one. |
| `ui_payload` atomicity; publish only after commit; `PresentUI` excluded from Tool projection (ADR-0017) | **Confirmed**, and stronger than stated: the published event embeds the DB-assigned sequence (A5). Exclusion is dual — use *and* result (D3). |
| Mirror fail-fast (ADR-0005) | **Partly misstated.** `agent-stream.ts` observes, aborts, stops, and reports; the `error`-vs-`interrupted` decision is in `run-serving.ts:532–550`. |
| Interruption observation (ADR-0013) | **Misattributed.** `agent-stream.ts` never observes the durable Run status. `run-serving.ts:280–329` polls `loadExecutingRunTx` on the heartbeat and fires `interruptionSignal`; `agent-stream.ts` only consumes that signal. What it *does* own is the bounded stop protocol (B2–B4) — which the ticket does not list. |
| Tool lifecycle correlation | **Confirmed** (D7, D8, A2). |
| Sequence numbering | **Confirmed but narrower than implied.** The returned sequences are used for exactly one thing — the `ui_payload` event id (`294–308`). Tool-batch sequences are discarded. The seam still returns them for every batch, and the count is checked (`206–208`). |
| Mirror-reliability reporting | **Split.** `mirrorErrorObserved` is from the stream; `mirroredMainSessionId` is from the `SessionStore` (C3), joined in `run-processor.ts:82–93`. |

**Missed by the ticket's list**, all inside-hook: the bounded 30 s stop / force-close protocol
(B2–B4); the post-await stop recheck around durable appends (B1); abandon-without-completion
(B6); mirror-triggered log redaction (C2); replay-message exclusion (D6); the whole ADR-0009
bounded projection and allowlist (D1, D2, D5); the fail-closed envelope protocol machine
(E1–E4), including E3's `is_error`-result-is-not-success rule and E2's divergence from
ADR-0008's stated "does not fail the run"; and the suppression requirement for adapter-emitted
`RUN_*` events (F3).

---

## 9. Implication for the map's central decision

The map asks whether the adapter's seams "permit a wrap that preserves
*commit-to-Postgres-then-publish*". Against this inventory, a pure downstream wrap
(`adapter.run(input).pipe(...)`) is **not sufficient**, for four independent reasons — any one
of which is disqualifying:

1. **A5**: a published event must carry a value assigned by a Postgres transaction that must
   happen after event formation. No downstream operator can supply it.
2. **B2–B5**: the stop protocol needs the SDK `Query` handle with three distinct stop
   semantics and a 30-second escalation. Observable unsubscription is not equivalent.
3. **B5/C1**: `mirror_error` is an SDK `system` message with no AG-UI representation. If the
   adapter does not surface it, the trigger is unrecoverable downstream.
4. **D1/D2/D7**: the adapter's tool events carry raw model-authored input and provider-derived
   ids, neither of which may ever be published. Its tool events must be dropped and rebuilt.

What a wrap *can* cleanly own is the mapping itself plus B7, C3, F2, and event filtering (F3).
That is a real but small slice of the 697 lines.

The concrete shapes that would make a wrap viable, in increasing order of upstream ask:

- **(a) A per-event async interception hook** — the adapter awaits a caller-supplied
  `beforeEmit(event, sdkContext)` that may commit, mutate, or drop the event. This alone
  resolves A1–A7, D1–D8, and E-class suppression.
- **(b) Exposure of the underlying `Query` handle** (or a stop API with graceful/immediate/
  30-s-escalation semantics) — resolves B2–B4.
- **(c) A raw SDK-message side channel** carrying messages with no AG-UI representation
  (`system/mirror_error`, `result.is_error`, `assistant.error`, `isReplay`) — resolves B5, C1,
  D6, E3.

If upstream will take (a)+(b)+(c) as contributions, the standing depend-and-wrap preference
holds. If not, the honest options are a hand-rolled projection on the canary lane (status quo)
or reusing only the adapter's pure type/encoding surface — which ADR-0012 already anticipated
in its own words:

> "The `@ag-ui/claude-agent-sdk` adapter is not used as the worker lifecycle owner because its
> in-memory session map, automatic client-Tool MCP bridge, forwarded option overrides, and
> direct `query()` ownership conflict with those guarantees. MyMemo may use AG-UI core types
> and encoding while projecting its already-supervised Claude SDK stream."

That sentence was written before this map opened; this inventory is the line-by-line evidence
for or against revisiting it.

---

## Sources read

- `apps/agent-worker/src/sdk/agent-stream.ts` (697 lines, in full)
- `apps/agent-worker/src/sdk/agent-stream.test.ts` (2232 lines, test-name survey)
- `apps/agent-worker/src/sdk/run-processor.ts`, `assistant-message-assembler.ts`,
  `ag-ui-text-stream.ts`, `tool-event-projection.ts`, `session-store.ts`,
  `start-run-query.ts` (query decorator)
- `apps/agent-worker/src/run-serving.ts`, `run-live-stream.ts`, `present-ui-tool.ts`
- `packages/agent-db/src/run-store.ts` (`appendRunEventsTx`), `src/run-events.ts`
  (`validateDurableRunEventSequence`)
- `packages/live-text/src/live-stream-events.ts` (event caps / text splitting)
- ADRs 0004, 0005, 0006, 0008, 0009, 0011, 0012, 0013, 0014, 0015, 0017, 0023
