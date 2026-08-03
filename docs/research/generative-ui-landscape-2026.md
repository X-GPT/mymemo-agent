# Generative UI Landscape for Agent Chat — Mid-2026 Survey

**Research date: 2026-07-17.** All substantive claims were verified against primary sources
(official specs, repos, first-party docs/blogs) on that date; where a claim could not be traced
to a primary source, it is flagged explicitly. Judging frame: MyMemo's durable run-event
pipeline (persisted events projected to SSE, **16 KiB never-split per-event cap**, full
replay/reconnect from persisted events), an **untrusted prompt-injectable agent** as payload
author (hard requirement: no script-execution path in the rendered payload), OpenRouter-routed
models (Claude and others) as authors, and three anchor use cases: **(a)** data displays
(tables/charts/comparisons), **(b)** document/citation cards, **(c)** diagrams & flows.
**Display-only**: interactivity is out of scope; interactive-first approaches are judged on
their display-only subset.

---

## Executive summary

The field has consolidated into **four structural paradigms**, and MyMemo's constraints slice
cleanly across them:

1. **Declarative component-catalog JSON** — the model emits a JSON tree/list of typed
   components from a fixed, client-owned allowlist; a trusted renderer maps them to native
   widgets. Instances: **A2UI** (Google-originated open protocol, v0.9.1 production / v1.0 RC),
   **json-render** (Vercel Labs, adopted by LangChain's official docs), **Adaptive Cards**
   (Microsoft, mature/maintenance), **Crayon/assistant-ui-style template registries**. This is
   the only paradigm that is simultaneously **script-free by construction**, **JSON-schema
   constrainable** (good for OpenRouter-routed models), and **naturally chunkable into small
   self-contained events**. It is the structurally compatible family for MyMemo.

2. **Developer-authored sandboxed HTML widgets over a tool protocol** — **MCP Apps**
   (SEP-1865, Final; official extension of the 2026-07-28 MCP spec, unifying MCP-UI and the
   OpenAI Apps SDK). Crucially the **model never authors the UI** — the tool developer
   predeclares an HTML template; the model only triggers tools. Script execution is contained
   (mandated sandboxed iframes, host-constructed CSP, no-network default), not absent. As an
   *ecosystem interop target* it is real and landing now; as MyMemo's payload paradigm it is
   heavyweight and its HTML templates are a (first-party-trusted) script path.

3. **Model-authored sandboxed HTML** — the Claude Artifacts pattern (`allow-scripts` iframe on
   a separate origin + strict no-network CSP). This is **contained script execution, not no
   script execution** — it fails MyMemo's hard requirement by definition, and whole-page HTML
   blobs (tens–hundreds of KiB) are hopeless against a 16 KiB never-split cap except by
   out-of-band reference. A no-scripts variant (sanitized static HTML/SVG in
   `<iframe srcdoc sandbox="">`) does satisfy the requirement but trades away JS charts and is
   less model-reliable than schema-constrained JSON.

4. **Transport/protocol layers with developer-owned rendering** — **Vercel AI SDK UI message
   streams** (typed `data-*` parts → developer React components) and **AG-UI** (CopilotKit's
   event vocabulary). These are not payload formats but plumbing; MyMemo already owns an
   equivalent durable event protocol, so the useful takeaway is their *pattern* (typed data →
   trusted components), which reduces to paradigm 1.

**Sub-format findings** that cut across paradigms: **Vega-Lite** is the best-in-class chart
payload (declarative JSON with a published JSON Schema; CSP-safe when rendered with
`vega-interpreter` and a deny-all data loader), and **Mermaid** is the best-in-class diagram
payload (tiny text DSL, universal LLM fluency) — but Mermaid has a sustained XSS-advisory tail,
no schema, and needs sandboxed/server-side rendering under an adversarial author. **Thesys C1**
is ruled out on multiple independent grounds (opaque proprietary DSL, proprietary SDK license,
routing model traffic through their API, poor 16 KiB fit).

---

## Comparison table

| Approach | Owner / status (2026-07) | Payload shape | Script-exec path (adversarial author) | 16 KiB / replay fit | Model-authoring reliability | (a) tables/charts | (b) citation cards | (c) diagrams | License / stack |
|---|---|---|---|---|---|---|---|---|---|
| **A2UI** | a2ui-project (ex-google/A2UI); v0.9.1 prod, v1.0 RC; very active | Flat adjacency-list JSON envelopes (`createSurface`/`updateComponents`/`updateDataModel`) vs client-owned catalog | **None** — declarative, catalog allowlist, no expression language | **Strong**: self-contained envelopes, chunkable at component boundaries, replay-from-zero deterministic; no mid-stream resume | JSON Schemas normative; first-party guidance is prompt + validate-retry (v0.9 pivoted away from strict structured output); first-party eval harness | No Table/Chart in base catalog — custom catalog components needed | Good (Card/List/Text-markdown) | **None** — custom component or image | Apache-2.0; renderer needed (Lit/React/Angular/Flutter shipped) |
| **MCP Apps / MCP-UI** | MCP SEP-1865 Final; official extension in MCP spec 2026-07-28; Claude/ChatGPT/VS Code/Postman/Goose render it | Developer-predeclared `ui://` HTML resource (`text/html;profile=mcp-app`); data via JSON-RPC notifications | **Yes (contained)** — HTML+JS in mandated double-sandboxed iframe, host CSP, no-network default; author is the *tool developer*, not the model | Template fetched out-of-band (good); events carry tool results + `ui://` ref; legacy embedded-resource style blows the cap | N/A for markup (model only emits tool calls; tool args are schema-validated) | Excellent (dev-authored widgets) | Good | Good (bundle any renderer in template) | Apache-2.0; TS SDK, React helpers optional; guest HTML free-form |
| **Vercel AI SDK (UI message streams)** | Vercel; `ai@7.0.30`, v7 GA 2026-06-25; RSC `streamUI` deprecated-in-practice | SSE stream of typed parts; `data-*` parts (id-reconciled JSON) → developer components | **None** — model never authors markup; data-value injection is on component author | Deltas small, but data-part writes carry the whole part (no fragmentation primitive); resume is Redis-backed live-stream only, not durable replay | Tool inputs schema-enforced (Zod/JSON Schema); stable `repairToolCall`; OpenRouter provider exists | Strong (dev components) | Strong | Via structured data + dev renderer | Apache-2.0; React/Vue/Svelte/Angular bindings |
| **AG-UI** | ag-ui-protocol org (CopilotKit); ~31 event types; broad integration claims | Event vocabulary (TEXT/TOOL_CALL/STATE_SNAPSHOT/STATE_DELTA w/ JSON Patch); rendering = developer components | **None** in core (tool rendering); shared writable state widens surface | STATE_DELTA cap-friendly; snapshots unbounded; durability/replay undefined by protocol | Per-SDK typed events; no markup authoring | Good | Good | Same as AI SDK | MIT; CopilotKit (React) is the mature client |
| **Thesys C1** | Thesys Inc (commercial); genui-sdk 0.10.3 pre-1.0; OSS pivoted to OpenUI lang | XML-tagged string wrapping proprietary undocumented DSL, rendered by closed React SDK | Declarative in principle; **no published security model** (unverified) | **Poor**: one opaque unbounded string per turn; no self-contained sub-event framing | Handled inside their hosted API (must route model traffic through C1) | Yes (built-in charts) | Yes | None documented | **Proprietary SDK** (internal-use-only license); React-only |
| **json-render** | Vercel Labs; 0.19.0, 15.7k★, adopted by LangChain docs | Flat `{root, elements{id}}` spec + **JSONL patch stream**; Zod catalog per component | **None** — declarative-only, no HTML/script escape hatch per docs | **Best-in-class**: append-only JSONL patches ≈ small self-contained events | `catalog.prompt()` + Zod validation; structured-output friendly | Via registered components (shadcn catalog; chart coverage unverified) | Any registered component | None documented | Apache-2.0; React/Vue/Svelte/Solid/RN/PDF/AdaptiveCards targets |
| **Adaptive Cards** | Microsoft; schema 1.6; maintenance-grade (2026-04 CVE fix) | Single nested JSON card, published JSON Schema | Declarative by design; md-subset + image URLs are the soft spots; renderer CVE history | Good: 1 card = 1 event; no streaming render | JSON Schema → strict structured outputs | Charts only via Teams host extension | Native use case | **None** | MIT; JS/.NET/Android/iOS/RN renderers |
| **Sandboxed HTML (Artifacts pattern)** | Anthropic's pattern; platform-native | Model-authored whole HTML page in `allow-scripts` iframe, separate origin, no-network CSP | **Yes (contained)** — attacker JS runs in viewer's browser; disqualified by hard no-script rule | **Poor inline**: pages are tens–hundreds of KiB (est., unverified) — out-of-band only | HTML always parses (error-recovery) but no schema constraint | Charts need JS (or model-emitted SVG) | Fine | Via model SVG/mermaid | Platform-native, framework-agnostic |
| **Sanitized static HTML/SVG (no-scripts variant)** | Platform-native + DOMPurify (cure53) | Model-authored HTML/SVG fragment, sanitized, rendered in `sandbox=""` srcdoc iframe | **None** — sanitizer strips script/handlers; empty sandbox blocks execution even on bypass | Fragments must be size-gated ≤16 KiB; self-contained; replayable | No schema; parse-forgiving but structurally unconstrained | Tables yes; charts only as static SVG | Good | Static SVG | Web platform + Apache-2.0/MPL-2.0 DOMPurify |
| **Mermaid** (diagram sub-format) | mermaid-js; 11.16.0 (2026-06-25), monthly cadence | Bespoke text DSL, no JSON schema | Renderer is trusted JS but has a **sustained XSS-advisory tail**; use `securityLevel: sandbox` or SSR | **Excellent**: sub-KiB–few-KiB text, self-contained, replayable | No schema → parse-to-validate + retry; LLM fluency high (productized first-party) | Weak (pie/xychart rudimentary) | No | **Best-in-class** | MIT; JS renderer (or Puppeteer SSR) |
| **Vega-Lite** (chart sub-format) | vega org (UW IDL); v6.4.3 (2026-04-24), maintenance-paced | Declarative JSON with **published JSON Schema** | **None** if rendered with `vega-interpreter` (no `Function`) + deny-all loader (no URL exfil), inline data only | Good: spec ~0.5–2 KiB + inline data (≈ a few hundred rows under 16 KiB); deterministic replay | **Best-in-class**: full JSON Schema → schema-constrained generation | **Best-in-class** | No | Poor (no graph layout) | BSD-3; JS renderer, SSR possible |

---

## 1. A2UI (agent-to-UI protocol)

**What/who/maturity.** A declarative protocol where agents emit JSON describing UI *intent*
and the client renders it with its own native component library — "AI agents generate rich,
interactive UIs that render natively across platforms … without executing arbitrary code"
([a2ui.org](https://a2ui.org/introduction/what-is-a2ui/)). Announced by Google on
2025-12-15 at spec v0.8
([Google Developers Blog](https://developers.googleblog.com/introducing-a2ui-an-open-project-for-agent-driven-interfaces/)).
As of 2026-07-17 the repo has **moved from `google/A2UI` to
[`a2ui-project/a2ui`](https://github.com/a2ui-project/a2ui)** (GitHub redirect confirmed;
~15.8k stars, pushed same day). Spec status: **v0.9.1 is "current production", v1.0 is a
release candidate**; the [roadmap](https://a2ui.org/roadmap/) targets v1.0 RC finalization
Q3 2026 and stability guarantees Q4 2026 — i.e., still pre-1.0 with churn (v1.0 renames
`theme`→`surfaceProperties`, restructures catalogs, adds bidirectional RPC per the
[v1.0 spec](https://a2ui.org/specification/v1.0-a2ui/)). First-party renderers in-repo: Lit,
Angular, React, Flutter, Markdown ([renderers/](https://github.com/a2ui-project/a2ui/tree/main/renderers));
SwiftUI/Compose are roadmap-only. Integrations: official ADK support
([adk.dev](https://adk.dev/integrations/a2ui/)), CopilotKit/AG-UI, AG2's `A2UIAgent`; Google
cites Opal, Gemini Enterprise, Flutter GenUI as users (announcement, ibid.). Ships an A2A
extension (`application/a2ui+json` DataParts) but is transport-agnostic
([extension spec](https://raw.githubusercontent.com/a2ui-project/a2ui/main/specification/v0_9_1/docs/a2ui_extension_specification.md)).

**Payload shape.** A stream of self-framed JSON envelopes, each with exactly one message-type
key: `createSurface`, `updateComponents`, `updateDataModel` (RFC 6901 JSON-Pointer paths),
`deleteSurface`. The UI is a **flat adjacency list** — components are `{id, component, ...props}`
referencing children by id, with one `root`; containers can bind a child template to a
data-model array path
([v0.9.1 protocol spec](https://raw.githubusercontent.com/a2ui-project/a2ui/main/specification/v0_9_1/docs/a2ui_protocol.md)).
The **catalog** is a client-owned JSON Schema naming the allowed component types and functions;
the [Basic Catalog](https://github.com/a2ui-project/a2ui/blob/main/specification/v0_9_1/catalogs/basic/catalog.json)
(~46.5 KB schema) defines Text (Markdown-capable), Image, Icon, Video, Row, Column, List, Card,
Tabs, Divider, Modal, Button, form inputs, and named functions (validators/formatters/`openUrl`).
Custom components = author your own catalog schema.

**Security.** "A2UI is a declarative data format, not executable code" (Google announcement,
ibid.). No expression language, no embedded code; the only logic is data-binding paths and
named functions resolved against the client's catalog — "This avoids sending executable code"
(protocol spec, ibid.). Containment is **catalog allowlist + schema validation** (standardized
`VALIDATION_FAILED` errors), not sandboxing — nothing executable crosses the boundary. The
spec's threat treatment is otherwise thin (agent impersonation in multi-agent setups is
covered; content-level attacks — phishing text, malicious `Image`/`openUrl` URLs — are left to
client catalog/URL policy). A display-only catalog stripped of Button/inputs/`openUrl` is
spec-legal and shrinks the residual surface to markdown/image content.

**16 KiB / replay fit.** Strong, with edges. Every message is a complete JSON object naming
its `surfaceId`; the producer chooses how many components per `updateComponents`, so events
can be sized under 16 KiB by splitting at component boundaries — incremental generation is a
stated design goal ("easy to generate incrementally, correct mistakes, stream",
[a2ui.org](https://a2ui.org/introduction/what-is-a2ui/)). Replay from event 0 reconstructs
state deterministically (component writes are last-write-wins). Edges: the stream is
**ordered and stateful** ("out-of-order delivery can corrupt the UI state"), a single prop or
data-model value is atomic (no string-append primitive — cap long text or shard it), and a
mid-stream subscriber missing earlier events renders a partial tree forever — A2UI events
belong in the durable replayed lane, not a best-effort lane. No normative message size limit
exists; example components run ~100–500 bytes (estimate from spec examples, not a spec claim).

**Model reliability.** Normative JSON Schemas ship in-repo
([specification/v0_9_1/json/](https://github.com/a2ui-project/a2ui/tree/main/specification/v0_9_1/json)).
Notably, **v0.9 deliberately pivoted away from strict structured output**: "While v0.8 was
optimized for LLMs that support structured output, v0.9 is designed to be embedded directly
within a model's prompt", with a recommended generate → validate-against-catalog →
feed-`VALIDATION_FAILED`-back retry loop; the spec itself flags "the LLM is not strictly
constrained by the schema" as the cost (protocol spec, ibid.). A first-party Genkit eval
harness benchmarks Gemini/OpenAI/Claude on A2UI generation
([eval README](https://raw.githubusercontent.com/a2ui-project/a2ui/main/specification/v0_9_1/eval/README.md)).
Documented failure modes: omitted required props (the catalog ships a `rules.txt` prompt
addendum about it), dangling id references, type mismatches.

**Anchor-use-case fit.** (a) **No Table and no Chart component in the Basic Catalog** (v0.9.1
and v1.0 RC alike); tables must be composed from Row/Column/List templates or Markdown-in-Text,
and charts are demonstrated only as custom catalog components ([a2ui.org samples](https://a2ui.org/)).
(b) Citation cards: good fit (Card/Column/Text/Image + List templates — squarely the demo
territory). (c) Diagrams: **not covered at all** — no diagram component in any first-party
catalog and none on the roadmap; a custom catalog component (e.g., one taking Mermaid/DOT
source) or a pre-rendered image is required.

**License/stack.** Apache-2.0. Protocol is framework-agnostic JSON; adopting it means either
using a shipped renderer (web: Lit reference, React/Angular) or writing one against the catalog
schema.

## 2. MCP Apps (SEP-1865) / MCP-UI / OpenAI Apps SDK

**What/who/maturity.** **SEP-1865 "MCP Apps — Interactive User Interfaces for MCP" is
Status: Final, Extensions Track** ([SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)),
authored by the mcp-ui creator (Ido Salomon) and others, explicitly unifying MCP-UI and the
OpenAI Apps SDK. The spec (version **2026-01-26, Stable**, extension id
`io.modelcontextprotocol/ui`) lives in
[modelcontextprotocol/ext-apps](https://github.com/modelcontextprotocol/ext-apps); per the
official MCP blog, the **2026-07-28 MCP spec release ships MCP Apps as an official extension**
— "servers ship interactive HTML interfaces that hosts render in a sandboxed iframe… Tools
declare their UI templates ahead of time so hosts can prefetch, cache, and security-review
them before anything runs"
([MCP 2026-07-28 RC post](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)).
SDK `@modelcontextprotocol/ext-apps` v1.7.4 (2026-06-05), Apache-2.0. Hosts rendering it per
the ext-apps README: Claude, ChatGPT, VS Code, Goose, Postman, MCPJam (Smithery/LibreChat per
mcp-ui's own docs table — not independently verified with those vendors).
[mcp-ui](https://github.com/idosal/mcp-ui) (Apache-2.0, client v7.1.1, 2026-05-09) is now the
reference implementation; its legacy content types (`rawHtml`, `externalUrl`, `remoteDom`)
predate the SEP — external URLs and Shopify-remote-dom were **deferred** from the standardized
MVP.

**Payload shape & who authors it.** The decisive property: **the model never emits UI.** The
tool developer predeclares an HTML template as an MCP resource (`ui://` URI, mimeType
`text/html;profile=mcp-app` — the only content type in the MVP); the model emits an ordinary
tool call; the host fetches/caches the template via `resources/read` and pipes args/results
into the rendered view via JSON-RPC notifications (`ui/notifications/tool-input`,
`tool-input-partial`, `tool-result`)
([spec 2026-01-26](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)).
The adversarial author is therefore the **MCP server operator** — a stable, reviewable,
pinnable identity — not the prompt-injected model; the model's residual channel is the data it
feeds the widget.

**Security.** Normative and detailed: "All View content MUST be rendered in sandboxed iframes
with restricted permissions"; web hosts **MUST** use a double-iframe with a cross-origin
sandbox proxy; the host constructs CSP from server-declared domain metadata and "MUST NOT
allow undeclared domains", with a **no-network default** (`connect-src 'none'`) when metadata
is omitted; all view↔host traffic is auditable JSON-RPC over postMessage (spec, ibid.).
Script execution is **acknowledged and contained, not avoided** — HTML+JS is the payload;
mitigation is sandbox + CSP + brokered capabilities + pre-execution template review. The
OpenAI Apps SDK has converged on the same shape (`ui://` + `text/html;profile=mcp-app`,
sandboxed iframe, JSON-RPC over postMessage) with a `window.openai` compatibility layer and
centralized submission review
([Apps SDK custom UX](https://developers.openai.com/apps-sdk/build/custom-ux),
[security guide](https://developers.openai.com/apps-sdk/guides/security-privacy)).

**16 KiB / replay fit.** Architecturally friendly to out-of-band reference: the durable event
needs only the tool's bounded result plus a `ui://` resource URI; the HTML template is a
separately fetched, cacheable, conversation-independent resource, and replay = re-fetch
template + re-feed persisted `structuredContent`. What does **not** fit is the legacy
mcp-ui embedded style where the full HTML blob rides inside the tool result — self-contained
widget bundles (examples inline entire compiled React bundles) are far beyond 16 KiB (no
primary source publishes typical byte counts; sizing is flagged inference).

**Anchor-use-case fit.** (a) Tables/charts: the primary target (ext-apps ships 20+ examples —
heatmaps, dashboards). (b) Citation cards: good (static template + per-call data under
no-network CSP). (c) Diagrams: good (a bundled mermaid/ELK renderer inside the template works
offline). Display-only hosts can implement just the render-side subset and stub every
view→host request — but still must build the sandbox-proxy + notification plumbing.

**License/stack.** Apache-2.0 spec + TS SDK; React helpers optional; guest HTML is free-form.

## 3. Vercel AI SDK generative UI

**What/who/maturity.** Two generations. The RSC generation (`streamUI` / `@ai-sdk/rsc`) is
not formally deprecated but Vercel's docs say "AI SDK RSC is marked as experimental, and we do
not recommend using it for stable production environments" and "we strongly recommend
migrating to AI SDK UI", listing five concrete limitations
([migration doc](https://ai-sdk.dev/docs/ai-sdk-rsc/migrating-to-ui)). The current generation:
**AI SDK 7** (GA 2026-06-25, `ai@7.0.30` on npm as of 2026-07-16; v5/v6 lines still patched)
([AI SDK 7 blog](https://vercel.com/blog/ai-sdk-7),
[releases](https://github.com/vercel/ai/releases)). "Generative UI is the process of
connecting the results of a tool call to a React component"
([generative UI docs](https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces)) — two
lanes: **tool parts** (typed `tool-${name}` parts with an input-streaming → output state
machine, rendered by developer components) and **data parts** (server-pushed typed `data-*`
parts, reconciled in place by id;
[streaming data docs](https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)).

**Payload shape / security.** SSE stream of JSON part deltas per the fully documented
[stream protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) (header
`x-vercel-ai-ui-message-stream: v1`). **The model never authors markup** in either lane; the
developer owns the React components, so the adversarial surface is data values flowing into
props (href schemes, oversized arrays) — on the component author. (AI SDK 7's opt-in MCP Apps
support is the one third-party-UI exception, iframed.)

**Durability / 16 KiB fit.** Resumability exists but is **live-stream-only and
infrastructure-backed** (the `resumable-stream` package + Redis + an `activeStreamId` column;
[resume docs](https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams)) — terminal history is
expected to come from your own persisted `UIMessage[]`, so it is not a durable replay log.
Against a 16 KiB cap: text deltas are small, but a **data-part update carries the entire part
payload each write** and the protocol has no fragmentation primitive — one large table part
exceeds the cap in a single logical event; chunking is app-level. The protocol documents no
per-event size limit.

**Model reliability.** Tool inputs are schema-enforced ("The schema is consumed by the LLM,
and also used to validate the LLM tool calls" — Zod or JSON Schema), with the now-stable
`repairToolCall` API and documented repair strategies
([tools & tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling));
`generateObject`/`streamObject` provide pure structured output with deep-partial streaming.
OpenRouter is served by the OpenRouter-maintained `@openrouter/ai-sdk-provider`
([provider page](https://ai-sdk.dev/providers/community-providers/openrouter)).

**Fit & license.** (a) tables/charts: strong (typed data parts + developer chart lib);
(b) citation cards: strong; (c) diagrams: good if the payload is structured nodes/edges —
model-emitted Mermaid source is just a string the protocol doesn't protect. Apache-2.0
([LICENSE](https://github.com/vercel/ai/blob/main/LICENSE)); React/Vue/Svelte/Angular bindings.
The structural caveat for MyMemo: this is **one vendor's client-stream protocol**, and MyMemo
already owns a durable event protocol — the transferable part is the typed-data-parts pattern,
not the wire format.

## 4. AG-UI protocol

**What/who/maturity.** "An open, lightweight, event-based protocol that standardizes how AI
agents connect to user-facing applications" — created by **CopilotKit**, MIT, ~14.8k stars
([repo](https://github.com/ag-ui-protocol/ag-ui), [docs](https://docs.ag-ui.com/introduction)).
The current events spec defines **~31 event types** (the README still says "~16"):
lifecycle (`RUN_STARTED`/`RUN_FINISHED`/`RUN_ERROR`), text (`TEXT_MESSAGE_START/CONTENT/END`),
tool calls (`TOOL_CALL_START/ARGS/END/RESULT`), and state — `STATE_SNAPSHOT` (full) plus
`STATE_DELTA` as **RFC 6902 JSON Patch**
([events](https://docs.ag-ui.com/concepts/events)). Transport-agnostic
(`run(input) -> Observable<BaseEvent>`; SSE reference transport,
[architecture](https://docs.ag-ui.com/concepts/architecture)). Verified first-party
integrations: Pydantic AI's `AGUIAdapter`
([pydantic docs](https://pydantic.dev/docs/ai/integrations/ui/ag-ui/)) and LangChain's
CopilotKit middleware ([langchain docs](https://docs.langchain.com/oss/python/langchain/frontend/integrations/copilotkit));
the README's Microsoft/Google/AWS claims were not independently verified this pass.

**Generative UI & security.** Same model as the AI SDK: **no model-authored markup** — agents
call tools / emit state and developers register render functions in CopilotKit
([generative UI docs](https://docs.copilotkit.ai/direct-to-llm/guides/generative-ui)). The
extra lane is bidirectional **shared state** (snapshot + JSON-Patch deltas), which widens the
surface (a prompt-injected agent can mutate app state); no formal threat-model document found.

**Durability / 16 KiB fit.** The protocol defines the live stream only — **no size limits, no
replay/durability semantics**; snapshots are the recovery primitive and are unbounded.
`STATE_DELTA` (JSON Patch) is cap-friendly. Its lifecycle vocabulary
(threadId/runId, RUN_STARTED/TEXT/TOOL_CALL) is structurally close to MyMemo's existing
`run_events` — it validates MyMemo's event design more than it replaces it.

**Fit & license.** (a)/(b) good via tool-rendering or state-driven components; (c) same
caveat as AI SDK. MIT; CopilotKit (React) is the mature client.

## 5. Thesys C1 (+ Crayon, OpenUI)

**What/who/maturity.** A hosted commercial "Generative UI API": an OpenAI
Chat-Completions-compatible endpoint that returns a UI specification instead of prose,
wrapping an underlying LLM you select per call (docs list Claude Sonnet 4 and GPT-5)
([implementing-api](https://docs.thesys.dev/guides/implementing-api),
[how-c1-works](https://docs.thesys.dev/guides/how-c1-works)). Rendering requires their React
SDK `@thesysai/genui-sdk` (v0.10.3, 2026-07-01, **pre-1.0**) with MIT `@crayonai/react-ui`
as the component kit ([rendering-ui](https://docs.thesys.dev/guides/rendering-ui)). Tiered
self-serve pricing with enterprise self-hosting exists
([pricing](https://www.thesys.dev/pricing)).

**Payload shape.** Per their own docs, "A C1 Response is a string … It uses an XML-like
structure": `<thinking>`, `<content>` (the proprietary, publicly **undocumented** "C1 DSL"),
`<artifact>` (how-c1-works, ibid.). The DSL is an opaque string handed to their closed SDK.

**Security & license.** Declarative in principle (fixed component vocabulary rendered by
their SDK), but **no published security model was found** — the docs don't address script
execution, prop sanitization, or injection hardening (flagged unverified). The SDK's
LICENSE.md (verified via unpkg) is **proprietary internal-use-only**, forbidding
redistribution, modification, and competing-SDK development. React-only.

**Strategic signal.** Thesys itself has pivoted its open-source effort **away from JSON**:
the crayon repo was renamed to [`thesysdev/openui`](https://github.com/thesysdev/openui)
(MIT, 8.1k stars, pushed 2026-07-17), "a compact streaming-first language" claiming 52–67%
token savings vs JSON formats in its own benchmarks. Crayon's npm packages remain published
(`@crayonai/react-ui` 0.9.16, 2026-02-03) and demonstrate the purest catalog pattern —
`ResponseTemplate { name, Component }` + `{type:"template", name, templateProps}` message
items (verified from published type definitions) — small, self-contained, event-friendly.

**Fit.** C1 as a product is a poor structural fit: opaque unbounded per-turn string (no
self-contained sub-event framing → poor 16 KiB fit), model traffic routed through a
third-party API (conflicts with the worker-owned OpenRouter credential architecture),
proprietary renderer, no diagram support documented. The *crayon pattern* (name + props
templates) survives as prior art for paradigm 1.

## 6. Component-catalog JSON (the general pattern)

The pattern: developer defines a fixed catalog of typed components (name + props schema); the
model emits `{component, props}` nodes (usually via structured output or tool calls); a
trusted client renderer maps them to real components, rejecting anything outside the catalog.
Beyond A2UI (§1) and Crayon (§5), the load-bearing instances:

**json-render (Vercel Labs).** "The Generative UI framework"
([repo](https://github.com/vercel-labs/json-render), Apache-2.0, created 2026-01-14, 15.7k
stars, `@json-render/core` 0.19.0). Catalog = `defineCatalog(schema, { components: { Card:
{ props: z.object({...}), description } } })` — **Zod schemas per component**; "the AI can
only use components in your catalog". The spec is **flat** (`{root, elements{id: {type,
props, children}}}`) with `$state` bindings and declarative visibility so the model never
generates logic; `catalog.prompt()` auto-generates the system prompt and output is validated
against the catalog ([docs](https://json-render.dev/docs)). Streaming is first-class via a
**JSONL patch stream** processed progressively — an append-only sequence of small
self-contained lines, structurally isomorphic to a durable replayable event log (the best
16 KiB story in this survey). Per docs there is no script execution and no HTML escape hatch.
Renderers: React, React Native, Vue, Svelte, Solid, plus PDF/Email/OG/Adaptive-Cards targets.
**LangChain's official generative-UI docs adopt it as their documented pattern**
([langchain docs](https://docs.langchain.com/oss/python/langchain/frontend/generative-ui)).
No diagram component documented; chart coverage of the community shadcn catalog unverified.

**Microsoft Adaptive Cards.** "Platform-agnostic snippets of UI, authored in JSON"
([adaptivecards.io](https://adaptivecards.io/)), MIT, schema **1.6** with a browsable
[Schema Explorer](https://adaptivecards.io/explorer/) (directly feedable to structured-output
APIs). Security by design: "Interactivity is expressed declaratively to help reduce risk of
custom code injection"; escape hatches are a limited Markdown subset in `TextBlock` and
remote `Image.url` fetches. Activity is **maintenance-grade** — last major JS release May
2024; most recent release is a security fix for **CVE-2026-27212** (repo pushed 2026-04-07)
([releases](https://github.com/microsoft/AdaptiveCards/releases)) — a reminder that even
declarative-format *renderers* are attack surfaces. Charts exist only as **Teams host
extensions** (`Chart.Donut/Line/Bar/...`,
[Teams charts doc](https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/charts-in-adaptive-cards));
no diagrams anywhere. One card = one self-contained low-KB JSON document = one durable event;
no streaming render. Proven LLM target (Copilot Studio renders agent responses as Adaptive
Cards, [docs](https://learn.microsoft.com/en-us/microsoft-copilot-studio/adaptive-cards-overview)).

**assistant-ui.** Documents both tool-UI registries and a first-class **Generative UI JSON
spec** primitive: `{root: node}` where nodes are `{component, props, children}`, validated
against an **allowlist registry** (unknown names throw), streamed progressively — with an
unusually honest first-party security note: "Spec props are spread directly onto your
allowlisted components, so treat every allowlisted component as receiving untrusted input"
([generative UI docs](https://www.assistant-ui.com/docs/tools/generative-ui)).

**Structured-output enablers.** OpenAI's structured-outputs guide demonstrates UI generation
with a recursive component schema and `strict: true` guarantees
([guide](https://developers.openai.com/api/docs/guides/structured-outputs);
[official generative-ui sample](https://github.com/openai/openai-structured-outputs-samples/blob/main/generative-ui/README.md)).
No equivalent first-party Anthropic doc dedicated to UI-generation via tool use was found
(stated explicitly rather than inferred); Anthropic tool-use schema enforcement serves the
same role in practice. Streaming partial-JSON parsing (AI SDK `streamObject` deep-partials,
the `partial-json` package) is the standard enabler for progressive rendering of catalog JSON.

**Pattern-level judgment.** This is the only paradigm where all five MyMemo constraints are
satisfiable simultaneously: no script path (catalog allowlist, declarative props), JSON-schema
constrained generation (works over OpenRouter tool-calling/structured output, with
validate-and-retry as the universal repair story), small self-contained payloads (one
component/card/patch per event), replay-safe (pure data), display-only trivially (omit action
components). Its two systematic gaps, across *every* catalog surveyed: **no diagram/flow
component exists in any first-party catalog** (Mermaid/DOT via a custom component is the
standard workaround), and charts are either absent (A2UI base), host-specific (Adaptive
Cards/Teams), or custom-component territory — pushing chart payloads toward an embedded
declarative sub-format (§8).

## 7. Sandboxed-HTML approaches

**The Claude Artifacts pattern (contained execution).** Anthropic's first-party documentation
of the pattern ([code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts)):
each artifact loads from a sandboxed separate origin (`*.claudeusercontent.com`) under "a
strict Content Security Policy" that "blocks scripts, stylesheets, fonts, and images loaded
from any other host, along with fetch, XHR, and WebSocket calls" — CSS/JS inlined, images as
data URIs, one self-contained page, **16 MiB cap**. Anthropic security engineer Ziyad Edher
(interview, second-party): "We use iFrame sandboxes with full-site process isolation"
([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts)).
The exact iframe `sandbox` token set and typical artifact byte sizes are **not published
first-party** (flagged unverified); structurally, self-contained styled pages run tens to
hundreds of KiB — routinely 2–50x a 16 KiB event cap.

**Platform mechanics (MDN/WHATWG).** Empty `sandbox=""` applies all restrictions — no script
execution at all; `allow-scripts` re-enables JS inside the frame; without `allow-same-origin`
the content gets an opaque origin; combining `allow-scripts` + `allow-same-origin` on
same-origin content lets the document strip its own sandbox — which is why serving from a
*different* origin matters ([MDN iframe](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)).
`srcdoc` + bare `sandbox` yields an opaque-origin inline document with zero hosting
infrastructure. Google's own guidance frames sandboxing as defense in depth, not "a complete
defense upon which you can solely rely"
([web.dev sandboxed iframes](https://web.dev/articles/sandboxed-iframes)).

**The split that matters for MyMemo.** With `allow-scripts`, attacker-authored JS *runs in
the viewer's browser* — CPU abuse, fingerprinting, deceptive UI inside the rectangle — and
"safe" rests on origin + CSP + token discipline all being right. That is **contained script
execution**, disqualified by MyMemo's hard requirement regardless of containment quality. The
compliant variant is **sanitized static HTML/SVG**: DOMPurify-strict (cure53, Apache-2.0/MPL-2.0,
v3.4.12 2026-07-11, [repo](https://github.com/cure53/DOMPurify)) or the WHATWG **HTML
Sanitizer API** (`Element.setHTML()` always strips script/event handlers — but as of mid-2026
only Firefox 148 + Chrome 146, no Safari, not Baseline;
[MDN](https://developer.mozilla.org/en-US/docs/Web/API/HTML_Sanitizer_API)) — rendered in
`<iframe srcdoc sandbox="">` so even a sanitizer bypass (mXSS, DOMPurify's historical bypass
class) lands where scripts don't execute. What a no-scripts sandbox renders: full declarative
HTML/CSS + inline SVG — styled cards, tables, static SVG charts — but **no JS chart
libraries**. Residual risks are non-script: deceptive content, CSS resource abuse, data-URI
size (bounded by a size gate).

**Adjacent implementations.** OpenAI Canvas publishes no first-party sandboxing detail
(verified absence). Vercel v0 and **e2b-dev/fragments** (Apache-2.0) run generated code in
*remote server-side sandboxes* and iframe the sandbox URL
(`sandbox="allow-forms allow-scripts allow-same-origin"` on a cross-origin remote URL,
verified in [fragments source](https://github.com/e2b-dev/fragments)) — the "run it for real,
remotely" end of the spectrum, out of scope for display payloads.

**Model reliability note.** No rigorous primary-source benchmark of HTML-vs-JSON emission
validity exists (flagged). Structurally: WHATWG HTML parsing mandates error recovery (every
byte stream parses to *some* tree — degrades, never fails), while JSON is parse-or-fail but
schema-constrainable. For a durable replayable stream, schema-constrained JSON is the more
controllable failure mode.

## 8. Declarative sub-formats (charts & diagrams)

These are not full generative-UI systems but payload types that slot *inside* a catalog or
event schema — and they are where the chart/diagram anchor use cases actually get solved.

**Mermaid** ([mermaid-js/mermaid](https://github.com/mermaid-js/mermaid), MIT). Very active:
**11.16.0 (2026-06-25)**, roughly monthly cadence, ~30 diagram types including Flowchart,
Sequence, State, ER, C4, Architecture ([intro](https://mermaid.js.org/intro/)). Payload is a
bespoke text DSL — **no JSON schema exists**, so no constrained decoding; validation is
parse-with-the-real-parser + retry. Security: four `securityLevel` modes; `strict` (default)
encodes HTML in labels, `sandbox` "renders in a sandboxed iframe … prevent[ing] any JavaScript
from running in the context" ([config docs](https://mermaid.js.org/config/schema-docs/config.html)).
The track record demands respect: **two Critical XSS advisories in Aug 2025** (sequence-diagram
labels, architecture iconText) and four more Moderate advisories as recently as **2026-05-11**
([advisories](https://github.com/mermaid-js/mermaid/security/advisories)) — under an
adversarial author, `securityLevel: sandbox` or server-side rendering to inert SVG
([mermaid-cli](https://github.com/mermaid-js/mermaid-cli), Puppeteer-based) is the defensible
posture, not `strict` alone. LLM fluency is high enough that Mermaid's own company productized
it ([Mermaid AI](https://mermaid.ai/mermaid-ai)); GitHub Markdown renders it natively
([GitHub docs](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/creating-diagrams));
Claude emits it as a first-class artifact type
([Anthropic help](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)).
Payloads are sub-KiB to a few KiB — comfortably one self-contained 16 KiB event.

**Vega-Lite** ([vega/vega-lite](https://github.com/vega/vega-lite), BSD-3-Clause). v6.4.3
(2026-04-24); active but maintenance-paced. Pure declarative JSON with a **complete published
JSON Schema** (`"$schema": "https://vega.github.io/schema/vega-lite/v6.json"`,
[spec docs](https://vega.github.io/vega-lite/docs/spec.html)) — the decisive reliability
property: schema-constrained structured output plus server-side pre-render validation. Two
security channels to close, both first-party documented: (1) the default expression evaluator
uses the `Function` constructor ("Vega is not compliant with standard Content Security
Policy", [security docs](https://vega.github.io/vega/usage/#security)) — use
**vega-interpreter** (AST-walking, CSP-compliant, ~10% slower,
[interpreter docs](https://vega.github.io/vega/usage/interpreter/)); (2) `data: {url}` is a
network/exfiltration channel — vega-embed's injectable loader lets a host **reject all URLs
and force inline `data.values`** ([vega-loader](https://github.com/vega/vega/tree/main/packages/vega-loader)).
With interpreter + deny-all loader + inline data, this is the strongest no-script chart story
surveyed. Size: spec ~0.5–2 KiB + inline data — a 16 KiB self-contained event holds roughly a
few hundred compact rows, fine for chat-scale charts, and replays deterministically with no
external fetches.

**Others, briefly.** **ECharts** option JSON admits JS callback functions — safe only as an
enforced pure-JSON subset; no official schema ([option docs](https://echarts.apache.org/en/option.html)).
**Plotly** figure JSON has a complete published schema but it's enormous and plotly.js is
heavy ([schema page](https://plotly.com/chart-studio-help/json-chart-schema/)). **Graphviz
DOT via viz-js** (MIT, v3.28.0 2026-06-03) does WASM layout only — no script path in the
payload; sanitize emitted SVG links ([viz-js](https://github.com/mdaines/viz-js)). **D2**
(MPL-2.0, Go, server-rendered SVG, v0.7.1 Aug 2025) is a good adversarial posture but a Go
toolchain dependency and younger DSL ([d2](https://github.com/terrastruct/d2)). **PlantUML**'s
own security page documents that its **legacy default profile has "full access to local files
and full access to URL"** — the renderer itself is an SSRF/file-read surface unless locked to
SANDBOX/ALLOWLIST ([plantuml.com/security](https://plantuml.com/security)); the cautionary
tale for "just run a diagram server".

**LangChain / LlamaIndex / Streamlit-Gradio.** LangChain's official generative-UI story is
json-render (§6); LangGraph Platform's own lane has developers author React components and
agents emit only component-name + props via `push_ui_message`, rendered in shadow DOM
([langgraph docs](https://docs.langchain.com/langgraph-platform/generative-ui-react)).
LlamaIndex's [`@llamaindex/chat-ui`](https://github.com/run-llama/chat-ui) (MIT, modest
activity — 0.6.1, Aug 2025) is a React widget library whose docs show rendering `mermaid`
code fences via a custom renderer. Streamlit and Gradio were checked and confirmed **not a
fit**: both are app frameworks where trusted developer code authors the UI; neither
first-party positions model-emitted declarative payloads in chat
([Streamlit chat tutorial](https://docs.streamlit.io/develop/tutorials/chat-and-llm-apps/build-conversational-apps),
[gr.ChatInterface docs](https://www.gradio.app/docs/gradio/chatinterface)). Every framework
surveyed converges on the same architecture: *model emits data/declarative text; developer
ships the renderer.*

---

## Implications for MyMemo's payload-paradigm decision

This is the tradeoff frame, not a decision.

### Structurally incompatible with the constraints

- **Model-authored HTML with scripts (Claude Artifacts pattern)** — fails the hard
  no-script-execution requirement *by definition* (contained ≠ absent), and whole-page blobs
  fail the 16 KiB never-split cap except as out-of-band references. Its origin/CSP hygiene is
  worth copying; its execution model is not.
- **Thesys C1** — opaque proprietary DSL with no self-contained sub-event framing (16 KiB
  fail), proprietary internal-use-only renderer license, no published security model, and it
  routes model traffic through a third-party API, conflicting with the worker-owned
  OpenRouter-credential architecture. Thesys's own pivot to OpenUI signals the C1 JSON-era
  format is not the bet even they are making.
- **Vercel AI SDK RSC (`streamUI`)** — deprecated-in-practice by Vercel's own docs.
- **Streamlit/Gradio-style app frameworks** — code execution *is* the UI; wrong paradigm.

### Compatible in pattern but not as adopted wire formats

- **Vercel AI SDK UI message streams** and **AG-UI** solve a problem MyMemo has already
  solved (a typed event stream with durable projection); adopting either wire format wholesale
  would mean replacing or bridging `run_events`. Their transferable content is the pattern —
  typed data parts / tool-call parts rendered by trusted developer components — which is
  paradigm 1 by another name. AG-UI additionally validates MyMemo's existing event vocabulary
  (RUN_STARTED/TEXT/TOOL_CALL lifecycle) as the industry-converged shape.
- **MCP Apps** is the ecosystem interop standard (Final SEP, shipping in the 2026-07-28 MCP
  spec, rendered by Claude/ChatGPT/VS Code). But its payload author is the *tool developer*,
  not the model — it answers "how do third-party tools ship UI" rather than "how does an
  untrusted model emit UI". For MyMemo it would mean building the double-iframe sandbox proxy
  and accepting first-party-authored HTML+JS templates as a trusted-but-contained script path.
  Relevant later if MyMemo ever hosts third-party MCP tools with UI; oversized for the three
  anchor use cases today.

### Viable candidates and what choosing each entails

1. **A fixed component-catalog JSON schema, projected as durable run events** (the pattern of
   A2UI / json-render / Adaptive Cards / crayon). This is the only family satisfying all five
   constraints simultaneously. Choosing it entails: defining MyMemo's catalog (a handful of
   display components: table, chart, citation-card, diagram, image, text) as JSON Schema /
   tool-input schemas the worker enforces; a new `run_events` type (or types) holding one
   self-contained component payload per event under the existing 16 KiB projection cap (the
   ADR-0009-style bounded-projection machinery already exists for tool events); a client
   registry renderer with reject-unknown fallback. Validation/repair = worker-side schema
   validation + feed-error-back retry, the universally documented story. The open sub-choice
   is *whose schema*: *(i)* **own bespoke catalog** — smallest surface, exact fit, no external
   churn, but no ecosystem renderers; *(ii)* **A2UI** — ecosystem momentum, event-log-friendly
   chunkable envelopes, multi-platform renderers, but pre-1.0 churn (v1.0 renames landing
   Q3–Q4 2026), no table/chart/diagram in the base catalog (custom components needed anyway),
   and ordered-stateful replay semantics to honor; *(iii)* **json-render** — best streaming/
   event isomorphism (JSONL patches) and Zod-native DX, but a single-vendor Labs project;
   *(iv)* **Adaptive Cards** — the most mature schema and proven LLM target, but
   maintenance-grade, chartless outside Teams, and style-rigid.
2. **Declarative sub-formats embedded as typed payloads inside that catalog** — this is how
   the two hardest anchor use cases actually get covered, since **no surveyed catalog ships
   chart or diagram components**: a `chart` component whose props are a **Vega-Lite spec**
   (schema-validated worker-side; rendered with vega-interpreter + deny-all loader + inline
   data only), and a `diagram` component whose props carry **Mermaid (or DOT) source**
   (rendered under `securityLevel: sandbox` in an isolated iframe, or server-rendered to inert
   SVG given Mermaid's 2025–2026 XSS advisory tail). Both payloads are small, self-contained,
   and replayable within 16 KiB. Cost: two trusted renderer dependencies and their upgrade
   hygiene.
3. **Sanitized static HTML/SVG fragments** (DOMPurify-strict + `srcdoc sandbox=""`) as either
   a fallback lane or the primary paradigm. Genuinely satisfies no-script-execution; covers
   cards and tables well and charts only as static SVG; weaker model-reliability story (no
   schema constraint; size must be gated post-sanitization per event). More plausible as the
   *safe fallback for unknown content* than as the primary format.

**Cross-cutting consequences regardless of choice.** (1) The 16 KiB never-split cap makes
"one self-contained component per event" the natural unit; anything bigger (large datasets,
full documents) must be referenced out-of-band — MyMemo's existing artifact/S3 lane is exactly
that mechanism. (2) The untrusted-author constraint means worker-side schema validation must
be the enforcement point (client validation is defense in depth), with a defined
unknown-component fallback frame. (3) Whatever renderer is chosen, its trusted-JS supply chain
(vega, mermaid, DOMPurify, card renderer) becomes a security-update surface — the Adaptive
Cards CVE-2026-27212 and Mermaid advisory history show declarative formats do not remove that
duty, they relocate it.
