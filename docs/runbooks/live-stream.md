# Live Stream operations

The retained Live Stream is a temporary per-Run Redis Stream. Postgres remains
authoritative for Run execution, complete messages, Tool activity, and terminal
Outcomes. A Live Stream alarm is a delivery incident: it must not fail service
health, restart a Run, or be counted as a model or Run failure.

## Ownership and signals

The CloudWatch namespace `<name-prefix>-<environment>/LiveStream` contains:

- `Operations`, dimensioned by bounded `Service`, `Operation`, and `Result`;
- `OperationLatencyMs`, dimensioned by `Service` and `Operation`;
- `RedisUnavailable`, dimensioned only by `Service`;
- `RecoveryResponses`, dimensioned by `Service` and `Result`;
- `CapacityFailures`, dimensioned only by `Service`; and
- `DegradedDurationMs`, dimensioned only by `Service`.

`agent-worker` owns producer acquisition, append, finalization, TTL refresh,
capacity enforcement, and persistence of `live_stream_failed_at`. `chat-api`
owns Live Stream reads, reconnect waits, retryable `503` responses, and
permanent-history recovery `410` responses.

Metric events contain only enumerated classifications, integer duration/count,
and service name. They never contain Assistant text, Tool arguments or results,
serialized AG-UI events, user or Conversation identity, Run or message ids,
Redis credentials, URLs, or full Redis keys. Failure logs may include the Run id
needed for operational correlation, but use a bounded reason code instead of a
thrown Redis error.

Use this Logs Insights query across the chat-api and agent-worker log groups:

```text
fields @timestamp, service, operation, result, reason, durationMs, count
| filter message = "Live Stream metric"
| stats sum(count), avg(durationMs), max(durationMs) by bin(5m), service, operation, result, reason
| sort bin(5m) desc
```

`degradation/started` is emitted only for a successful null-to-time
`live_stream_failed_at` transition. `degradation/ended` measures from that
persisted timestamp until the Run terminalizes. These metrics are deliberately
separate from Run Outcome metrics; a Run may still have Outcome `done` after
Live delivery degrades. Stale-run recovery emits the same transition and
duration pair when it creates the marker after an owner disappears.

## Respond to alarms

### Sustained Redis unavailability

The per-service alarm identifies the owner:

1. For `agent-worker`, inspect `acquire`, `append`, `finalize`, and `refresh`
   failures and latency. Confirm Runs still terminalize and permanent history
   remains available.
2. For `chat-api`, inspect `read_wait`, `reconnect_response`, and
   `recovery_response`.
   Confirm ownership checks still precede Redis reads and clients receive `503`
   while retry is valid or `410` when history recovery is required.
3. Check ElastiCache availability, connections, CPU, memory, and network
   reachability from the two trusted ECS services. Do not log or paste
   `REDIS_URL`.

### Elevated recovery responses

`chat-api` owns this alarm. Inspect `history_410`, then compare it with
`retryable_503` reconnect results in `Operations`. Check `DegradedDurationMs`
and the worker's Redis failures. Confirm the target
Run eventually appears terminal in permanent Conversation history. A rise in
`410` with healthy Postgres Outcomes indicates delivery degradation, not model
failure.

### Capacity-bound failures

`agent-worker` owns this alarm. Inspect the bounded reason in logs:
`event_too_large`, `stream_bytes_exceeded`, or `stream_events_exceeded`. Confirm
the Run continued through Postgres and that the client recovered from history.
Do not raise limits before identifying whether an event projection or Run is
unexpectedly large.

All alarms notify `alarm_action_arns`; production must point it at a confirmed
incident subscription. After restoration, run a new Conversation turn and
confirm producer acquisition, successful append/finalize, a terminal AG-UI
event, and permanent history agree.
