# Sandbox origin

The origin that serves model-authored HTML+JS for the sandboxed generative-UI
lane ([map #430](https://github.com/X-GPT/mymemo-agent/issues/430),
ticket [#438](https://github.com/X-GPT/mymemo-agent/issues/438)).

It is deliberately trivial: it serves a document and a set of response headers,
holds no secret, reads no database, and reaches no other service. The headers
*are* the security boundary.

## Why a Worker, not a static page behind a Transform Rule

Charting assumed the no-egress CSP would ride a Cloudflare **Transform Rule**,
because that is how you retrofit a header onto `mymemo.ai`, which is served by
nginx on EC2 and sets no security headers at all today.

For a **new** origin that reasoning inverts. A Worker sets its own response
headers, so the policy ships as versioned code next to the thing it protects,
is reviewable in a diff, and cannot drift out from under us via a dashboard
edit. It also leaves room for the server-side document composition
[#431](https://github.com/X-GPT/mymemo-agent/issues/431) settled on, which a
static bucket could not serve. Cloudflare Workers is already a production
platform for this team (`memex-cloudflare`), so this adds no new vendor.

## Why no domain purchase is needed to stand this up

`workers.dev` is on the [Public Suffix List](https://publicsuffix.org/list/),
so the account's `<subdomain>.workers.dev` is **its own registrable domain** —
already fully separated from `mymemo.ai` for cookies, storage, and any future
auth change. That is the property #438 requires, so the prototype
([#432](https://github.com/X-GPT/mymemo-agent/issues/432)) can proceed today
with no purchase, no DNS record, and no TLS setup.

A dedicated vanity domain remains the right end state, and it is a pre-launch
step rather than a prerequisite. Note that the industry pattern is a
PSL-**wildcarded** user-content domain — `*.auiusercontent.com`,
`*.oaiusercontent.com`, `*.usercontent.goog` are all wildcard entries — which
lets each payload get its own registrable domain. PSL submission has a long
lead time (browser release cycles), so if per-payload origin separation is
ever wanted, that clock starts early.

## Deploy

Needs Cloudflare account access.

```bash
bun add -g wrangler && wrangler login
```

```bash
cd infra/sandbox-origin && wrangler deploy
```

`wrangler deploy` prints the deployed `*.workers.dev` URL. Record it on #438.

## Verify

Header-level evidence:

```bash
./infra/sandbox-origin/verify.sh https://mymemo-sandbox-origin.<subdomain>.workers.dev
```

In-page evidence — open the deployed URL in a browser. It renders a probe table
that attempts every escape a payload could try (fetch, XHR, WebSocket,
sendBeacon, image beacon, EventSource, `localStorage`, `document.cookie`,
parent DOM, same-origin script, WebRTC) and reports what the browser did.
`document.title` and `<html data-probe-status>` carry the verdict, and
`window.__SANDBOX_PROBE__` the structured results.

## Run it locally

```bash
bun infra/sandbox-origin/dev-server.ts
```

Serves the same bytes and headers on `:8787`, plus an embedder on `:8788` that
frames it cross-origin with a fake `ADMIN_SECRET_TOKEN` in its localStorage.
`?drop=frame-ancestors,sandbox` omits directives, to bisect the envelope one
directive at a time.

**The local harness cannot exercise the framed case.** Chrome blocks *every*
opaque-origin frame load of an `http://localhost` target — verified to be
independent of this policy, since it still happens with `frame-ancestors` and
`sandbox` both removed. Framed behaviour needs the real HTTPS origin.
