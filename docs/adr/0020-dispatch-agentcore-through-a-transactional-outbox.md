# Dispatch AgentCore through a transactional outbox

Status: accepted

Admission of a Run on an AgentCore-canary Conversation will atomically create
an outbox record, which is published at least once to an encrypted standard SQS
queue. The consumer invokes AgentCore for that exact Conversation and Run, but
Postgres Conversation Ownership and Run state remain the ordering,
duplicate-execution, and recovery authority. SQS delivery order and
deduplication therefore carry no correctness weight.

The consumer acknowledges delivery only after a typed Dispatch disposition
proves Durable acquisition, proves the exact Run is already durably acquired,
or proves it already has an Outcome. Temporary contention and ambiguous
infrastructure failures retry; malformed or lane-mismatched poison work is
acknowledged and alarmed. Merely entering the Runtime, receiving HTTP success,
or finding text resembling `RUN_STARTED` is never sufficient.

The Runtime communicates that proof through a strict, versioned Acquisition
receipt whose identifiers must match the dispatch envelope. The receipt is
emitted only after the disposition's durable transaction commits. On new
acquisition, the Lambda consumer may then close its response stream and
acknowledge SQS while the Runtime continues the Run detached.

## Considered options

- **Publish after admission without an outbox.** Rejected because a crash
  between the database commit and SQS publish would strand an admitted Run.
- **Use SQS FIFO ordering or deduplication as the execution authority.**
  Rejected because AgentCore does not serialize same-session invocations and
  publisher ambiguity still permits duplicate delivery.
- **Acknowledge when Runtime invocation begins.** Rejected because container
  entry does not prove that the requested Run obtained durable authority.

## Consequences

- The manual launcher makes an immediate bounded publish attempt after
  admission, while a scheduled invocation of the same publisher repairs
  pending rows.
- Publisher row claims expire, making concurrent publishers and retry after an
  ambiguous SQS result safe.
- The Runtime adapter needs a specific-acquisition primitive and typed receipt;
  it cannot reuse the global Fargate drain loop unchanged.
