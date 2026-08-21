# Emit display-only generative UI as catalog payloads

Status: accepted

When a visual presentation serves an answer better than prose — a comparison,
a distribution, a source list, a process explanation — the agent should be
able to present one. The agent is untrusted and prompt-injectable, so the
contract's hard rule is that no payload may carry a script-execution path,
and every payload must fit the durable pipeline: persisted `run_events`
projected to SSE under the 16 KiB never-split event cap, replayable from
Postgres forever. This ADR locks the wire contract decided across the
generative-UI wayfinder map (#320); the landscape survey behind it is
`docs/research/generative-ui-landscape-2026.md` (PR #327), and the rendering
prototype that reality-checked it was recorded in PR #414.

The payload paradigm is **component-catalog JSON**: the model emits typed
components from a fixed, client-owned allowlist, and a trusted renderer maps
them to native widgets. The survey found this the only paradigm that is
script-free by construction, schema-constrainable for OpenRouter-routed
models, and naturally sized to small self-contained events; the deciding
criterion was native assistant-ui support, and mymemo-web's pinned
`@assistant-ui/react` 0.14.27 ships the exact primitive (`generative-ui`
message parts rendered against a component registry). Rejected: model-authored
sandboxed HTML (contained execution is not no execution, and whole pages
cannot ride 16 KiB events), sanitized static HTML/SVG as the primary format
(no schema to constrain the model), enriched markdown (the prose lane already
owns text, and parsing UI out of free text fights ADR-0008), Thesys C1, and
wholesale adoption of A2UI / json-render / Adaptive Cards / AI-SDK / AG-UI
wire formats (each needs adapter renderers and none ships chart or diagram
components — we would author custom components under someone else's churn).
The catalog is therefore bespoke and assistant-ui-shaped.

## Emission

The model emits a payload by calling one dedicated executor tool,
**`PresentUI`**, on the existing `mymemo-executor` in-process MCP server and
the pinned ADR-0006 allowlist. Its JSON args are the payload — exactly one
self-contained component tree per call. The model never supplies the durable
envelope's `messageId` or `version`. Claude Code omits MCP tools whose input
schema has a top-level `oneOf`, so the model-visible schema is a direct root
object with the component enum and a nested union of the five strict prop
shapes; the executor remains authoritative for component/props correlation
and card-only children. The executor validates and persists;
the model receives a bounded ack, or on validation failure a typed error
result naming the violated rule, and may repair and retry. An invalid payload
is **never persisted**: no invalid content ever reaches a client, and there
are no truncation semantics — an over-cap payload is rejected whole, never
clipped, because a clipped UI spec has no meaning. Fenced in-text conventions
were rejected (ADR-0008 streams provisional deltas live, so a half-streamed
fence leaks raw JSON; free text has no schema channel and no retry seam), as
was artifact-style publication (end-of-turn only; payloads must sit inline in
the message flow). The ADR-0011 artifact lane remains a candidate overflow
for content that legitimately exceeds the cap — a future decision.

Steering lives in the `PresentUI` tool description alone for v1: reach for a
payload when visual form materially beats prose (quantitative comparisons and
distributions → `chart`/`table`; source attribution → `citation-card`;
process or structure explanations → `diagram`); never to decorate an answer
prose already serves; the UI is display-only and must never solicit
interaction; and the surrounding message text must carry the answer on its
own even if the payload never renders. A system-prompt paragraph is a
deliberate later lever — both surfaces are worker-owned static strings.

## Wire contract

`run_events.type` gains one member, a canonical model event:

```ts
UiPayload: "ui_payload"

interface UiPayloadEventPayload {
	messageId: string; // owning Assistant message, MyMemo-issued
	version: 1;        // envelope + catalog schema version, breaking-change-bumped
	payload: UiNode;   // one validated component instance
}

type UiComponent = "chart" | "diagram" | "table" | "citation-card" | "card";
type UiNode = {
	component: UiComponent;
	props: Record<string, unknown>; // per-component schemas below
	children?: (string | UiChildNode)[]; // `card` only
};
// Child nodes have no children slot: depth ≤ 2 is structural, not counted.
type UiChildNode = { component: Exclude<UiComponent, "card">; props: Record<string, unknown> };
```

The Live Stream projection is a standard AG-UI **`CUSTOM`** event named
`mymemo.generative_ui` — the same extension point as the shipped
`mymemo.run_interrupted` — whose value is the event payload plus the durable
event id. The `PresentUI` call is **excluded from tool-event projection**: no
`tool_call_*` events, no ack projection; the `ui_payload` event is its only
record, because client-side the payload is content, not tool activity.
Delivery is **commit-only**: validate → commit → publish whole, under the
same commit-before-publish rule as every other event; the spec never streams
progressively, so nothing unvalidated is ever visible and reconnect replay is
identical to live delivery. Replay and permanent history treat `ui_payload`
exactly like tool events: backlog replay delivers it whole in event order,
history projects it as a `generative-ui` part inside its owning Assistant
message, and an interrupted Run retains every payload committed before
interruption. Whether the worker persists the event in the executor at call
time or in the stream consumer at the message boundary is deliberately left
to implementation; the contract binds only ordering, `messageId` correlation,
only-valid-payloads-persist, and commit-before-publish.

Clients render envelope versions they know; an unknown `version` receives the
same framed fallback as an unknown component name. Additive growth — a new
component, a new optional prop — does not bump `version`; the registry
fallback already covers it.

## Catalog v1

Five components. Only `card` accepts `children` (strings render as text;
nodes may be any component except `card`); ≤ 16 children per card, string
children ≤ 1,000 chars. Named caps are normative inside the 16 KiB envelope
so validation errors tell the model what to shrink:

| component | props | caps |
|---|---|---|
| `chart` | `title?`, `spec` (Vega-Lite) | spec ≤ 8 KiB serialized; inline `data.values` ≤ 200 rows; `data.url` forbidden at schema level |
| `diagram` | `title?`, `source` (Mermaid) | source ≤ 4 KiB |
| `table` | `title?`, `columns[{key,label,align?}]`, `rows[]` | ≤ 50 rows; ≤ 8 columns; cell text ≤ 200 chars |
| `citation-card` | `title`, `snippet`, `source{collection?,updated?,pages?}`, `relevance?` | title ≤ 200; snippet ≤ 500; source fields ≤ 100; relevance ∈ [0, 1] |
| `card` | `title?`, `tone?` | title ≤ 200; children bounds above |

Text policy: `card` string children and `citation-card.snippet` admit
CommonMark **strong/em only**; every other text prop is plain text. No
URL-bearing prop exists anywhere in v1 — no `image` component (a `src` is a
fetch/phishing/exfiltration channel; if images return, they return as their
own decision on data-URIs vs signed internal refs), no links in citations
(document click-through is deferred to its own decision), no standalone
`text` component (string children and the prose lane cover it).

## Trust rules (normative)

- Worker-side schema validation is the enforcement point; client checks are
  defense in depth. The worker enforces the catalog schemas, the caps table,
  the children rule, and the envelope cap; the chart's Vega-Lite spec is
  validated against the published Vega-Lite JSON Schema.
- Renderers MUST NOT execute any payload-carried code path: Vega-Lite renders
  with `vega-interpreter` (no `Function` constructor), a deny-all data loader,
  and inline data only; Mermaid renders under `securityLevel: sandbox` in an
  isolated frame or is server-rendered to inert SVG — `strict` alone is
  insufficient given Mermaid's advisory history.
- Markdown-lite is enforced by renderer capability, not linting: the
  emphasis-only renderer has no link/image/HTML/autolink constructs, so such
  syntax renders as literal text. Renderers MUST NOT linkify or execute any
  construct beyond strong/em.
- Unknown component name or unknown envelope `version` → the framed fallback,
  never a render attempt and never a crash.

## Renderer guidance (non-normative)

mymemo-web's adapter maps `mymemo.generative_ui` to the native assistant-ui
part `{ type: "generative-ui", spec: { root: node }, id: <event id> }` and
renders via `MessagePrimitive.GenerativeUI` with the component registry — the
division of labor both frameworks document. Payloads render **inline as
first-class message content**; the framed collapsible treatment is reserved
for failure states (unknown component/version) and optionally bulky tables —
boxing a presentational payload in tool-activity chrome demotes the answer to
machinery, which the prototype showed. Prose keeps streaming around the
payload, so commit-only delivery leaves no dead air.

## Consequences

- `@mymemo/agent-db` gains the `ui_payload` event type; the worker gains the
  `PresentUI` tool, its validation, and one allowlist entry; chat-api's relay
  carries the CUSTOM event untouched. That implementation is a follow-on
  effort, not this map's.
- mymemo-web adds one adapter case and the component registry, plus `vega`
  (with `vega-interpreter`) and `mermaid` as trusted dependencies whose
  security updates become an owned duty — declarative formats relocate the
  renderer supply chain, they do not remove it.
- The catalog grows by schema + registry, never by new tools or event types;
  breaking prop changes bump the envelope `version` and older frontends
  degrade to the framed fallback rather than mis-rendering.
- Deferred by decision, each returning as its own effort: interactivity,
  document click-through on citations, an `image` component, artifact-lane
  overflow for over-cap content, and a system-prompt steering paragraph.
