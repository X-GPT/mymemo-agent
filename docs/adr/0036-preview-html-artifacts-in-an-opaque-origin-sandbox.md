# Preview HTML artifacts inline in an opaque-origin sandbox

Status: accepted

Amends [ADR-0017](./0017-emit-display-only-generative-ui-as-catalog-payloads.md)
(which rejected model-authored sandboxed HTML) and
[ADR-0011](./0011-publish-downloadable-artifacts-on-success.md)
(whose "content type never permits inline rendering" rule covered downloads).

Some answers are a page, not a paragraph or a single widget: a dashboard over a
Conversation's documents, a timeline, a comparison across many sources. The
ADR-0017 catalog stays the right shape for one chart, one table or one diagram —
it is script-free by construction and the model cannot invent a component. It is
deliberately not a layout language, so it cannot express a composed page, and
widening it into one would re-import every problem it was designed to avoid.

The Agent may therefore write **one self-contained HTML page as an ordinary
artifact**, and `mymemo-web` renders it **inline in the chat inside an
opaque-origin sandboxed iframe**. The model stays untrusted and
prompt-injectable; nothing below assumes otherwise.

## Why ADR-0017's rejection no longer holds on this lane

ADR-0017 rejected model-authored sandboxed HTML on two grounds.

- *"Whole pages cannot ride 16 KiB events."* Void here. The page is not an
  event. It is an artifact: the model writes `artifacts/<name>.html`, the front
  mirrors it to S3 on the existing ADR-0011 publication boundary, and the client
  fetches it over HTTP. It is bounded by the artifact caps, not the event cap,
  and it replays from history like any other artifact.
- *"Contained execution is not no execution."* Still true, and still the reason
  the catalog remains the default for single widgets. We now accept contained
  execution **on the artifact lane only**, because the containment below leaves
  the executing page with no credentials, no network and no reachable surface.

## Containment

The page runs only under
`<iframe sandbox="allow-scripts" referrerpolicy="no-referrer" srcdoc=…>`. The
sandbox omits `allow-same-origin`, so the document has an opaque origin and
cannot reach the app's cookies, `localStorage` or DOM, and it omits
`allow-forms`, `allow-popups`, `allow-top-navigation`, `allow-modals` and
`allow-downloads`, so it cannot submit, open a window, navigate the app or start
a download.

The client injects a Content-Security-Policy `<meta>` as the **first** element
of `<head>` before handing the string to `srcdoc`:

```
default-src 'none'; script-src 'unsafe-inline' {origin}/agent-libs/;
style-src 'unsafe-inline'; img-src data: blob:; font-src data:;
connect-src 'none'; form-action 'none'; frame-src 'none'; object-src 'none';
base-uri 'none'
```

`{origin}` is the app's own origin. The page therefore has **no network at all**
except our vendored, pinned library directory: no exfiltration channel, no
remote-resource channel, no beacon, no font or image call-home. Chart.js is
vendored under `public/agent-libs/` in `mymemo-web` rather than loaded from a
CDN, so the one allowed script source is a file we ship.

## Delivery

`Artifact` gains a derived `previewable: boolean` — true when
`contentType === "text/html"` and `sizeBytes <= 1 MiB`. It appears in
`GET /v1/conversations/:id/artifacts` and in the `data-artifacts` stream part.
It is computed on read from the stored manifest, never persisted, so the rule
can change without a manifest migration.

`GET /v1/conversations/:id/artifacts/:artifactId/content` returns the object
bytes to the owner, ownership-checked exactly like `download-url` and equally
outside the exposure gate. Unknown, foreign and not-previewable artifacts all
return the same `404`, so the route discloses nothing the listing does not. It
reads with `GetObject` and does not presign: 1 MiB is far under the 6 MB Lambda
response cap, and proxying keeps the bytes behind the ownership check instead of
behind a bearer URL. The response is
`content-type: text/plain; charset=utf-8`, `x-content-type-options: nosniff`,
`cache-control: private, max-age=300`, `content-disposition: inline`.

`text/plain` is the point: the bytes are never a document on our origin. Only
the client turns them into one, and only inside `srcdoc`. ADR-0011's rule that a
content type never permits inline rendering stands unchanged for downloads,
which keep their forced-attachment presigned URL.

The page is produced by the static system prompt, not by a new tool. The prompt
tells the model when a page beats prose, where to write it, that inline CSS and
JS are the only styling and scripting, that `/agent-libs/chart.umd.js` is the
one permitted external resource, and that fetching, forms, links and `<base>`
are pointless because the CSP blocks them. Publication stays the ADR-0011
artifact boundary; no model-facing publish tool is added.

## Residual risk

A page can render misleading UI — phishing-style text, a fake sign-in form that
cannot submit — to the single user who owns the Conversation. It cannot collect
what it displays, reach any origin, or persist beyond the artifact. Accepted:
the surrounding assistant message must carry the answer in prose regardless, so
the page is an illustration and not the only channel. Artifacts remain
unscanned untrusted generated files under ADR-0011, and `mymemo-web` continues
to present them as such.
