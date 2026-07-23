# Stream durable, client-safe tool events

Status: accepted

The client needs to show the agent's tool arguments and returned results. Add
`tool_use` and `tool_result` as additive, unversioned SSE frames projected from
durable, ordered `run_events`. Tool events commit only at complete-message
boundaries. Under ADR-0008, SDK `assistant` events are content-block completion
records inside one provider response envelope, not complete messages: the worker
buffers allowlisted `tool_use` blocks and appends them only when that envelope
reaches its matching `stream_event.message_stop`. A `tool_result` is derived only
from a complete, non-replay SDK user message and means that tool returned.
Partial `input_json_delta` fragments and SDK user messages with `isReplay: true`
never create tool events. Text streaming remains the separate concern recorded
by ADR-0008.

The two frames are append-only and self-describing rather than updates to a
shared client object. They expose the short public tool name but no tool-call
correlation id; the worker may use the SDK id internally to associate a result
with its tool. A run may terminate with `interrupted` or `error` after `tool_use`
without a matching `tool_result` rather than fabricating a result.

```ts
type PublicToolName =
	| "Read"
	| "Write"
	| "Edit"
	| "Grep"
	| "Glob"
	| "Bash"
	| "SearchDocuments"
	| "ListDocuments"
	| "LoadDocuments";

type ToolUseEvent = {
	type: "tool_use";
	tool: PublicToolName;
	arguments: Record<string, unknown>;
	truncated: boolean;
};

type ToolResultEvent = {
	type: "tool_result";
	tool: PublicToolName;
	result: Record<string, unknown>;
	isError: boolean;
	truncated: boolean;
};
```

Each event is capped at 16 KiB of UTF-8 JSON after projection and is never split
across frames. Projection is explicit per tool, never a pass-through of SDK
input, executor output, document audit rows, or transcript entries:

- `Read` exposes path/line-window arguments and a capped content preview with
  line metadata.
- `Write` and `Edit` expose paths, capped text previews and byte counts; results
  expose bytes written or replacement count.
- `Grep` exposes search arguments and bounded path/line/column/text-preview
  matches; `Glob` exposes its arguments and a bounded path list.
- `Bash` exposes a capped command preview, cwd and timeout; its result exposes
  exit code, capped stdout/stderr previews, outcome and truncation flags. A
  nonzero process exit is a returned command result, not a tool error.
- `SearchDocuments` exposes a capped query and bounded title/snippet previews;
  `ListDocuments` exposes the requested limit, whether pagination continued,
  the exact scoped total, returned count, whether more results remain, and a
  bounded title preview; `LoadDocuments` exposes the requested count and
  bounded title/error summaries. Document ids, passage ids, pagination cursors,
  scope/policy details and docs-cache paths remain internal.

The document-query preview is a deliberate, narrow exception to the earlier
implementation-plan rule that document-access details stay out of client SSE.
Only the bounded query, title and snippet projections above become client
visible. The audit row itself is never projected, and document ids, passage ids,
scope filters and policy decisions remain audit-only.

Preview fields are non-authoritative: a short source may happen to fit fully,
but the client must not treat a preview as a full file or document body. The
current tool-result boundary flattens validation and infrastructure failures into
the same text shape, so every `tool_result` with `isError: true` projects the
fixed `{ message: "Tool failed" }` result rather than classifying strings. A
successful tool result that contains per-item failures exposes only counts and
fixed summaries, never raw error text. A tool error does not end the run; the
agent may recover and continue. Failure to persist a run event is instead a
run-level error and never becomes a `tool_result`.

## Consequences

- Live delivery and reconnect replay preserve durable append order through the
  existing per-run sequence and `Last-Event-ID` cursor. At one assistant
  envelope's `message_stop`, its single `assistant_text` / `text_commit` is
  appended first when it has visible text, followed by its `tool_use` events in
  tool-block order. A textless envelope appends only its ordered tool uses;
  results from one SDK user message retain their tool-result block order. This is
  deterministic but deliberately does not claim to reconstruct arbitrary
  text/tool interleaving inside ADR-0008's single text commit.
- Existing clients must ignore the two new SSE event names until they render
  them; no response-shape feature flag or API version is added.
- Unknown, built-in or permission-denied tool names are logged and omitted.
  Malformed payloads that cannot be safely projected are likewise logged and
  omitted without failing otherwise valid agent work. SDK replay messages are
  ignored rather than copied into a new run's history.
- Failure to append a valid tool event is not optional: the same ownership fence
  and run-failure behavior used for assistant content applies.
- The separate `document_access_events` ledger remains the security/compliance
  record. Client tool events do not replace it or inherit its sensitive fields.
