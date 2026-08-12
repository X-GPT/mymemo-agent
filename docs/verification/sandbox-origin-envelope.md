# Sandbox origin: envelope verification

**Measured 2026-08-12, Chrome, against `infra/sandbox-origin` served locally**
([#438](https://github.com/X-GPT/mymemo-agent/issues/438), map
[#430](https://github.com/X-GPT/mymemo-agent/issues/430)).

Every row below is an observation from a real browser, not an inference. Where
the local harness could not settle a question, that is stated as such rather
than filled in.

The policy under test is `infra/sandbox-origin/src/policy.ts`. Its shape:
`default-src 'none'` with `connect-src`, `form-action`, `base-uri`,
`object-src`, `media-src`, `frame-src`, `child-src`, `worker-src` and
`manifest-src` all `'none'`; `script-src`/`style-src` `'self' 'unsafe-inline'`;
`img-src 'self' data: blob:`; `frame-ancestors` listing the mymemo.ai origins;
and `sandbox allow-scripts` — deliberately **without** `allow-same-origin` and
**without** `allow-popups`.

## Contained

| Channel | Evidence |
|---|---|
| `fetch()` | Rejected `TypeError`; console: *"Refused to connect… violates… connect-src 'none'"* |
| `XMLHttpRequest` | `onerror`; `connect-src` violation logged |
| `WebSocket` | `wss://` connection refused; `connect-src` violation logged |
| `navigator.sendBeacon` | `connect-src` violation logged — **see the trap below** |
| `<img>` beacon | `onerror`; `img-src` violation logged |
| `EventSource` | `connect-src` violation logged |
| `localStorage` | Throws `SecurityError` — the embedder's `ADMIN_SECRET_TOKEN` is unreachable |
| `document.cookie` | Throws `SecurityError` |

**Zero requests reached the network.** The browser's network panel recorded no
request to the external host across all six egress attempts.

### The `sendBeacon` trap

`navigator.sendBeacon()` returned **`true`** for a request CSP then blocked. The
return value only reports that the send was *queued*; it is not evidence of
transmission, and a test that trusts it reports a false escape. The probe was
rewritten to adjudicate on `securitypolicyviolation` events instead. Any future
egress test in this lane must do the same.

## The load-bearing property, now demonstrated

The frame runs at an **opaque origin** (`window.origin === "null"`), so it
cannot read `localStorage` at all. MyMemo's auth credential lives in
`localStorage` (`ADMIN_SECRET_TOKEN`) and rides as an explicit header rather
than as a cookie, which is why origin isolation is worth so much here — the
credential is neither readable by the frame nor ambient on its requests.

This was previously an *unwritten* assumption. It is now demonstrated, but it
remains an assumption about mymemo-web: a future move to cookie auth would
silently weaken this lane. That belongs in the ADR as a stated precondition.

## Known gaps

### `'self'` matches nothing — the runtime and every library must be inlined

Under the opaque origin, `'self'` resolves to nothing. Measured:

| Load | Result |
|---|---|
| Same-origin `<script src>` | **blocked** (`net::ERR_BLOCKED_BY_CLIENT`) |
| Same-origin `<img src>` | **blocked** |
| Same-origin `<link rel=stylesheet>` | **blocked** |
| `data:` image | loaded |
| `blob:` URL creation | works, scoped as `blob:null/…` |

This cuts across a decision already taken. [#431](https://github.com/X-GPT/mymemo-agent/issues/431)
settled that we "serve a versioned document from the sandbox origin carrying
the CSS reset, the component styling, the named design tokens and the
**self-hosted libraries**." Serving them is fine; loading them *as files* is
not. Every byte of the runtime and of every bundled library must be **inlined
into each composed document**.

Consequences, which #439 and #437 have to price in:

- **No HTTP caching across payloads.** A conversation with N sandboxed frames
  transfers the library set N times. This gives the map's "per-conversation
  frame cost" fog a concrete mechanism.
- **The library budget is per-document, not amortised.** A 100 KB charting
  library is 100 KB on every frame load.
- The `run_events` payload is unaffected — the durable event holds only the
  fragment, so ADR-0009's 16 KiB cap is untouched. The weight lands on the
  *served document*, which is not durable.

The escape hatch is granting `allow-same-origin`, which restores `'self'` — but
that also restores storage and defeats the opaque origin, so it is only
defensible on a **per-payload origin**, which is the PSL-wildcard pattern the
big vendors use. That is a real fork, and it is now ticketed.

### WebRTC survives the envelope

`RTCPeerConnection` is constructible. CSP has no directive that covers it
(CSP3 specifies `webrtc`; no tracked browser implements it), so a payload that
wants to exfiltrate can still open a peer connection. This confirms
[#433](https://github.com/X-GPT/mymemo-agent/issues/433)'s finding against a
live browser rather than against spec text. Unaddressed, by us and by every
system surveyed.

## Not settled here

- **The framed case.** Chrome blocked every opaque-origin frame load of an
  `http://localhost` target. This is *not* caused by the policy: it still
  happens with `frame-ancestors` and `sandbox` both stripped from the header,
  and it does not happen when the frame keeps a real origin
  (no `sandbox` attribute, or `allow-scripts allow-same-origin`). It is a
  property of the plain-HTTP loopback harness. The parent-DOM probe, the
  `frame-ancestors` enforcement check and the height protocol therefore need
  the real HTTPS origin — they are #432's to settle after deploy.
- **Cloudflare edge behaviour**: that TLS provisions and that the edge passes
  the CSP header through untouched. Deploy-time facts.
- **Hostile payload behaviour** (throw / hang / CPU spin) — #432.

## Reproducing

```bash
bun infra/sandbox-origin/dev-server.ts
```

Open `http://localhost:8787/` and read the probe table; `?drop=<directive>`
bisects the policy. `./infra/sandbox-origin/verify.sh <origin>` checks headers.
