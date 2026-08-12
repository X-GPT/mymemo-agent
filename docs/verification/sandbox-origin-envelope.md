# Sandbox origin: envelope verification

**Measured 2026-08-12, Chrome — first against `infra/sandbox-origin` served
locally, then re-verified against the deployed origin
`https://mymemo-sandbox-origin.bruce-waynezu.workers.dev`**
([#438](https://github.com/X-GPT/mymemo-agent/issues/438), map
[#430](https://github.com/X-GPT/mymemo-agent/issues/430)).

Every row below is an observation from a real browser, not an inference. Where
the local harness could not settle a question, that is stated as such rather
than filled in.

**Deploy verification:** Cloudflare's edge passes the CSP through
byte-for-byte (`verify.sh` fully green over TLS), TLS provisions, the origin
sets no cookie, and the in-page probe reports every channel contained with
WebRTC as the sole known gap.

> **Correction (same day):** the local harness produced one **false
> negative**, recorded below in its own section. The first version of this
> document claimed `'self'` matches nothing at an opaque origin; the deployed
> origin disproved that. Local claims that the deployed origin confirmed are
> kept; that one is retracted.

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

## Retracted: the `'self'`-matches-nothing claim (a harness false negative)

The local harness reported same-origin `<script src>`, `<img src>` and
`<link rel=stylesheet>` loads as blocked at the opaque origin, and the first
version of this document concluded the runtime and libraries had to be inlined
into every composed document. **The deployed origin disproved this**: on
`https://mymemo-sandbox-origin.bruce-waynezu.workers.dev`, under the identical
CSP with `sandbox allow-scripts`, the probe's same-origin script **executed**
— libraries **can** be served as same-origin files, and HTTP caching across
payloads works normally.

The deployed behaviour is also what CSP specifies: `'self'` is bound to the
**response URL's origin** when the policy is parsed, not to the document's
post-sandbox opaque origin, so sandboxing does not sever it.

The local failure's own error code was the tell, missed at the time:
`net::ERR_BLOCKED_BY_CLIENT` is a *client-side request blocker* (here, the
in-app browser pane used for the local run), not a CSP verdict — CSP blocks
log as `securitypolicyviolation`. The same artifact explains the harness's
inability to load opaque-origin *frames* of localhost targets, previously
attributed to Chrome loopback behaviour.

**Rules this adds for every future measurement in this lane:**

1. `ERR_BLOCKED_BY_CLIENT` is never CSP evidence. Only a
   `securitypolicyviolation` event (or a console CSP violation) proves the
   policy acted — the same rule the `sendBeacon` trap already established for
   the opposite direction.
2. A *negative* result (a load failing) from an embedded/test browser is
   untrusted until reproduced in a stock browser against the real origin.

Consequence for the map: ticket #441's original premise dissolves — the
composed document may load the runtime and libraries as cacheable same-origin
files under plain `allow-scripts`, no `allow-same-origin` and no per-payload
PSL-wildcard origin required for that purpose.

## Known gaps

### WebRTC survives the envelope

`RTCPeerConnection` is constructible. CSP has no directive that covers it
(CSP3 specifies `webrtc`; no tracked browser implements it), so a payload that
wants to exfiltrate can still open a peer connection. This confirms
[#433](https://github.com/X-GPT/mymemo-agent/issues/433)'s finding against a
live browser rather than against spec text. Unaddressed, by us and by every
system surveyed.

## Not settled here

- **The framed case.** The local run could not exercise it: every
  opaque-origin frame load of an `http://localhost` target was refused with
  `ERR_BLOCKED_BY_CLIENT` — not the policy (it persisted with
  `frame-ancestors` and `sandbox` both stripped) but the test browser's own
  request blocker, per the retraction above. The parent-DOM probe, the
  `frame-ancestors` enforcement check and the height protocol need a
  mymemo.ai-origin embedder (or a dev origin temporarily added to
  `frame-ancestors`) against the deployed HTTPS origin — they are #432's.
- **Hostile payload behaviour** (throw / hang / CPU spin) — #432.

Settled since the first version of this document by the deploy: TLS
provisions, and Cloudflare's edge passes the CSP header through untouched
(`verify.sh` green against the live origin, 2026-08-12).

## Reproducing

```bash
bun infra/sandbox-origin/dev-server.ts
```

Open `http://localhost:8787/` and read the probe table; `?drop=<directive>`
bisects the policy. `./infra/sandbox-origin/verify.sh <origin>` checks headers.
