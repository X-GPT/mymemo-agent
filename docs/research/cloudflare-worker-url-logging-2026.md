# Can the sandbox origin avoid logging request URLs? — Cloudflare Workers, 2026-08

**Research date: 2026-08-12.** Answers [#444](https://github.com/X-GPT/mymemo-agent/issues/444),
feeding the residual-risk section and sandbox-origin obligations of **ADR-0018**
([#437](https://github.com/X-GPT/mymemo-agent/issues/437)). Part of map
[#430](https://github.com/X-GPT/mymemo-agent/issues/430).

Every claim below is either **[DOC]** — traced to `developers.cloudflare.com` or Cloudflare's own
published source/artifacts, quoted verbatim — or **[MEASURED]** — observed against our own
deployed Worker on this date — or explicitly flagged **[UNDOCUMENTED]** / **[INFERENCE]**. Blogs
and StackOverflow were not used. Where Cloudflare is silent, this document says so rather than
guessing, because a wrong "it's fine" here would put a false security promise into a durable ADR.

---

## The question

[#434](https://github.com/X-GPT/mymemo-agent/issues/434) measured one egress path the CSP cannot
close: `frame-src 'self'` lets an untrusted payload navigate to **our own** origin with arbitrary
bytes in the URL. The bytes land in whatever records that origin's request URLs. Since the shell
needs `frame-src 'self'` to function, the mitigation is a logging constraint, proposed as normative
on #437:

> The sandbox origin MUST NOT log, store, reflect, or forward request URLs or query strings, and
> MUST NOT expose any endpoint that does.

Nobody had checked whether the platform permits that. The origin is a Cloudflare Worker
([#438](https://github.com/X-GPT/mymemo-agent/issues/438)).

---

## First: what this risk actually is

**Added after the first draft, because the rest of this document reads more alarming than the risk
warrants.** The URL in question always points at **our own origin** — that is precisely why CSP
cannot close the channel, and equally why the channel does not reach anyone hostile. Every path to
an attacker-controlled host is closed (`connect-src 'none'`, every fetch directive host-free). So
the bytes land in **our** Cloudflare logs, which the party who planted the script cannot read.

This is therefore **data hygiene, not exfiltration**: one payload's worth of what the model was
already displaying to the user, sitting in a third-party log for 24 h to 30 days, readable by anyone
with access to our Cloudflare account. Real, worth one honest paragraph in ADR-0018, and *not* worth
engineering against. Read every "still records the secret" below in that light — it means the bytes
are written somewhere they should not be, never that an attacker receives them.

## Bottom line

**The clause as written is not keepable, and should not go into ADR-0018 in that form.**

Three independent reasons, in descending order of importance:

1. **The URL-bearing record is manufactured by the platform, not by our code.** A Worker that never
   calls `console.log` still produces an invocation record whose message is `<Method> <URL>`.
   "We don't log" is not a property our source code can have. **[DOC]** + **[MEASURED]**
2. **The Worker cannot neutralise the sink.** Rejecting the request, 404-ing it, or redirecting to
   a stripped URL does not un-observe it — the record is built from the *inbound* request and the
   response status is recorded alongside it, not in place of it. **[MEASURED]**
3. **Cloudflare's own URL protection is a heuristic that an adversary defeats by construction.**
   Real-time logs redact hex/base64-shaped query values — and pass all-lowercase values through
   verbatim. A payload controls its own encoding. **[MEASURED]**

4. **At least one retaining surface has no off-switch at all, once the origin sits on a zone.**
   `firewallEventsAdaptive.clientRequestQuery` records the query string on **every plan including
   Free**, and it fires whenever any security product acts on the request — so **blocking the
   exfiltration request still records the secret**. Added after the first draft; see
   [the zone section](#the-sharpest-zone-surface-firewalleventsadaptiveclientrequestquery--not-opt-in-not-suppressible).
   **[DOC]**

**What *is* achievable** is a narrower, configuration-level promise, and it is narrower still than
this document first claimed: no query-string-bearing record is *retained* in any surface we control
**and can configure**, because the one on-by-default retaining surface (Workers Logs invocation logs)
has a documented off-switch and every other *opt-in* retaining surface we decline. What survives
regardless is **live observability to authorized operators** (`wrangler tail` / dashboard Live logs,
not stored, no documented off-switch), **counter-only analytics** (no URL dimension, 3-month
retention, no documented off-switch), and — on a zone — **Security Events, which is not
configurable away** (reason 4).

The durable protection is therefore not "don't log the URL". It is **do not let a secret exist in a
place where the payload can move it into a URL** — see [What ADR-0018 should say](#what-adr-0018-should-say).

---

## Surface-by-surface

Ordered by how much they matter to us. "Query string?" means: does this surface carry the full URL
*including* the query string?

| Surface | Query string? | Default | Retention | Off-switch |
|---|---|---|---|---|
| **Workers Logs** (invocation logs) | **Yes** (message is `<Method> <URL>`) | **ON** for new Workers; **we opt in explicitly** | 3 d free / **7 d** paid | **Yes** — `observability.logs.invocation_logs: false`, or `observability.enabled: false` |
| **Workers Traces** | **Yes** — `url.full`, and `url.query` as its own attribute | **OFF** (opt-in) | 3 d free / 7 d paid | Yes — don't set `traces.enabled` |
| **Real-time logs / `wrangler tail`** | **Yes**, heuristically redacted | On demand, **not config-gated** | **None** ("does not store") | **None documented** |
| **Tail Workers** (`tail_consumers`) | Yes — `event.request.url` | OFF (opt-in) | ours to decide | Yes — no binding |
| **Workers Logpush** (Workers Trace Events) | Yes, inside `Event` | OFF (opt-in, Paid plan) | destination's | Yes — no job, `logpush` unset |
| **Workers metrics / analytics** | **No URL dimension** — counts, durations, statuses | **Always on** | **3 months** | **None documented** |
| **Analytics Engine** | Only what we write | OFF — needs a binding we don't have | — | N/A |
| **Zone HTTP request logs** (`ClientRequestURI`) | **Yes**, by definition | zone-scoped, opt-in | varies | Yes — but see workers.dev note |
| **Log Explorer** | Yes | OFF (opt-in per dataset) | — | Yes — disable datasets |

### Workers Logs — the one on-by-default surface that retains the URL

This is the surface that matters, and it is on for us today.

**[DOC]** <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>

> Each Workers invocation returns a single invocation log that contains details such as the
> Request, Response, and related metadata. These invocation logs can be identified by the field
> `$cloudflare.$metadata.type = "cf-worker-event"`. Each invocation log is enriched with
> information available to Cloudflare in the context of the invocation.

> In the Workers Logs UI, logs are presented with a localized timestamp and a message. The message
> is dependent on the invocation handler. For example, Fetch requests will have a message
> describing the request method and the request URL, while cron events will be listed as cron.

The handler table on that page gives, verbatim, for **Fetch**: `<Method> <URL>`.

> By default a Worker will emit invocation logs containing details about the request, response and
> related metadata.

**Default state.** Cloudflare states it twice, and the two statements are in mild tension — worth
knowing, because they answer different questions:

> All newly created Workers will come with the observability setting enabled by default.

> You must add the observability setting for your Worker to write logs to Workers Logs.

and, from <https://developers.cloudflare.com/workers/wrangler/configuration/>, on `enabled`:

> When set to `true` on a Worker, logs for the Worker are persisted. Defaults to `true` for all new
> Workers.

Reconciliation: new Workers get the setting on; a Worker with no `observability` block does not
write logs. Cloudflare's own wrangler source makes the second case concrete — on deploy it sends
`observability: worker.observability ?? { enabled: false }`, i.e. omitting the key actively pushes
`enabled: false`. **[DOC, source]** `cloudflare/workers-sdk`,
`packages/deploy-helpers/src/deploy/deploy.ts`. Relying on that is relying on a wrangler internal;
set it explicitly instead.

**None of this is theoretical for us — we opted in.** `infra/sandbox-origin/wrangler.jsonc` today:

```jsonc
"observability": {
    "enabled": true
},
```

**Off-switch.** **[DOC]**, same page:

> Invocation logs can be disabled in wrangler by adding the `invocation_logs = false` configuration.

```jsonc
{ "observability": { "logs": { "invocation_logs": false } } }
```

**Retention.** **[DOC]** limits table: "Maximum log retention period — **7 Days**" (paid; free is
3 days). Also "Maximum logs per account per day — 5 Billion", after which "a 1% head-based sample
will be applied for the remainder of the day". Default `head_sampling_rate` is 1, i.e. no sampling.

**No field-level control.** **[UNDOCUMENTED]** Cloudflare documents no redaction, masking,
field-exclusion, or PII filtering for Workers Logs. The controls are all-or-nothing (`enabled`),
record-class (`invocation_logs`), or volume (`head_sampling_rate`).

**Open, and material: does the persisted record keep the query string?** The stored *message* is
documented as `<Method> <URL>`, and `<URL>` is unqualified. The Query Builder docs
(<https://developers.cloudflare.com/workers/observability/query-builder/>) only ever exemplify
`$workers.event.request.path` and `$workers.event.request.cf.country` — *path*, which elsewhere in
Cloudflare's vocabulary explicitly excludes the query string. Cloudflare publishes **no exhaustive
field list** for the persisted store. So: the URL is certainly in the stored message; whether the
stored form retains the query string is **[UNDOCUMENTED]**. Treat as "probably yes, unverified".

### Workers Traces — opt-in, and the most explicit about query strings

**[DOC]** <https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/>

Attributes for the **incoming Fetch Handler** root span include `url.full` and `url.path`.
Attributes for **Runtime API `fetch`** spans include `url.full`, `url.scheme`, `url.path`, and
**`url.query`** as a dedicated attribute.

So Cloudflare captures the query string as a first-class span attribute where it captures it at all.
Whether `url.full` on the *incoming handler* span includes the query string is **[UNDOCUMENTED]** —
the name implies yes; Cloudflare never defines it.

Opt-in: `"observability": { "traces": { "enabled": true } }`. Retention 3 d free / 7 d paid.
We do not set it. **[UNDOCUMENTED]**: whether top-level `observability.enabled: true` cascades to
traces. Do not assume it leaves tracing off.

### Real-time logs / `wrangler tail` — the surface with no off-switch

**[DOC]** <https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>

> Real-time logs does not store Workers Logs. To store logs, use Workers Logs.

> A maximum of 10 clients can view a Worker's logs at one time. This can be a combination of either
> dashboard sessions or `wrangler tail` calls.

> Real-time logs captures invocation logs, custom logs, errors, and uncaught exceptions. For
> high-traffic applications, real-time logs may enter sampling mode, which means some messages will
> be dropped and a warning will appear in your logs.

Nothing is retained — good. But it is **not gated by the `observability` config**, and Cloudflare
documents **no way to disable it** at Worker, zone, or account level. **[UNDOCUMENTED]** Any account
member with Workers permissions can attach and watch URLs in real time. For our threat model this is
a *live visibility* exposure, not a durable-record exposure.

### Tail Workers, Logpush, Analytics Engine — all opt-in, all declined

**Tail Workers.** **[DOC]** <https://developers.cloudflare.com/workers/observability/logs/tail-workers/>
delivers `event.request.url` to a consumer Worker, verbatim in the documented example:

```json
"event": { "request": { "url": "https://example.com/some/requested/url", "method": "GET" } }
```

Opt-in via `tail_consumers` on the producer. We declare none. Retention is whatever the consumer
does — Cloudflare documents none of its own.

**Workers Logpush.** **[DOC]** <https://developers.cloudflare.com/workers/observability/logs/logpush/>

> Workers Trace Events Logpush includes metadata about requests and responses, unstructured
> `console.log()` messages and any uncaught exceptions. This product is available on the Workers
> Paid plan.

Opt-in twice over: a Logpush job must exist, and the Worker must set `logpush`. The
`workers_trace_events` dataset fields are `CPUTimeMs`, `DispatchNamespace`, `Entrypoint`, `Event`,
`EventTimestampMs`, `EventType`, `Exceptions`, `Logs`, `Outcome`, `ScriptName`, `ScriptTags`,
`ScriptVersion`, `WallTimeMs`. The URL lives inside `Event` ("Details about the source event"),
whose sub-schema Cloudflare does **not** document. **[UNDOCUMENTED]**

**Analytics Engine.** **[DOC]** <https://developers.cloudflare.com/analytics/analytics-engine/>

> Workers Analytics Engine provides unlimited-cardinality analytics at scale, via a built-in API to
> write data points from Workers, and a SQL API to query that data.

It is an explicit-write API requiring an `analytics_engine_datasets` binding. Nothing lands there
implicitly, and our Worker declares **no bindings at all** — deliberately, per the comment in
`wrangler.jsonc`. Not a sink for us.

**"Trace Workers".** Not a current Cloudflare product name; the current name is **Tail Workers**.
"trace" survives in the informal prose of the tail handler docs and in the Logpush dataset name
`workers_trace_events`. **[UNDOCUMENTED]** No Cloudflare page formally records a rename, so treat
"Trace Workers → Tail Workers" as an association, not a cited fact.

### The redaction heuristic — and why it does not save us

**[DOC]** <https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/>

> Some of the properties of `TailRequest` are redacted by default to make it harder to accidentally
> record sensitive information, like user credentials or API tokens. The redactions use heuristic
> rules, so they are subject to false positives and negatives. Clients can call `getUnredacted()` to
> bypass redaction, but they should always be careful about what information is retained, whether
> using the redaction or not.

> URL redaction: For each greedily matched substring of ID characters (a-z, A-Z, 0-9, '+', '-',
> '\_') in the URL, if it meets the following criteria for a hex or base-64 ID, the substring will
> be replaced with the string "REDACTED".
> - Hex ID: Contains 32 or more hex digits, and contains only hex digits and separators
> - Base-64 ID: Contains 21 or more characters, and contains at least two uppercase, two lowercase,
>   and two digits.

Cloudflare says outright it is heuristic and bypassable (`getUnredacted()`). Measurement below shows
it is worse than that for our threat model.

---

## Measured

Method: `wrangler tail --format json` against the deployed Worker (`mymemo-sandbox-origin`), then
`curl` with benign markers in the query string. Ground truth is the platform's own emitted event
object, not documentation about it. No real secret was placed in any Cloudflare log.

### 1 — the URL, including query string, is delivered; and our own logging is irrelevant

`GET /?probe444=BENIGN-MARKER-NOT-A-SECRET&second=alsobenign` produced:

```json
{
  "outcome": "ok",
  "scriptName": "mymemo-sandbox-origin",
  "logs": [],
  "exceptions": [],
  "event": {
    "request": {
      "url": "https://mymemo-sandbox-origin.bruce-waynezu.workers.dev/?probe444=BENIGN-MARKER-NOT-A-SECRET&second=alsobenign",
      "method": "GET"
    }
  }
}
```

`"logs": []` — the Worker emitted nothing of its own. The full URL with query string is in the event
regardless. **A Worker that logs nothing is not a Worker whose URLs are unobserved.**

### 2 — rejecting the request does not help

`GET /nope?rejected404=BENIGN2`, which our Worker answers with `404 "not found"`:

```json
{ "outcome": "ok", "logs": [],
  "event": { "request": { "method": "GET",
    "url": "https://mymemo-sandbox-origin.bruce-waynezu.workers.dev/nope?rejected404=BENIGN2" } },
  "response": { "status": 404 } }
```

The event is built from the **inbound** request; our response status is recorded *alongside* it.
This is the direct answer to "can the Worker reject any request bearing a query string?" — **no**.
By the time our code can inspect `url.search` and decide, the URL is already in the event. The same
disposes of redirect-to-stripped-URL: the first request is already recorded, and the 302 merely adds
a second event.

Cloudflare's zone-side field definitions say the same thing structurally **[DOC]**
(<https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/>):

> `ClientRequestURI` — URI requested by the client, which includes the full path and query string of
> the requested URL.

> `ClientRequestPath` — URI path requested by the client, which includes only the path portion of
> the requested URL, without the query string.

The field is defined by what *the client* requested; `EdgeResponseStatus` separately records what
Cloudflare returned. Note that Cloudflare deliberately models "with query string" and "without query
string" as two different fields — the secret lands in `ClientRequestURI`.

### 3 — the redaction heuristic is trivially evaded

One request carrying three differently-shaped values:

```
/?hex=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef&b64=AbcdEfgh12ijklMnop34qrst&plain=lowercasesecretnodigits
```

delivered as:

```
/?hex=REDACTED&b64=REDACTED&plain=lowercasesecretnodigits
```

- `hex` (40 hex digits) matched the Hex ID rule → redacted.
- `b64` (24 chars, ≥2 upper, ≥2 lower, ≥2 digits) matched the Base-64 rule → redacted.
- `plain` (23 chars, all lowercase, no digits) matched neither → **passed through verbatim**.
- **Parameter names always survive** (`hex=`, `b64=`, `plain=`).

This is the load-bearing security result. Redaction keys on the *shape* of the value, and **an
untrusted payload chooses its own encoding**. Base32-into-lowercase, or any all-lowercase alphabet,
walks straight through. Cloudflare's redaction protects against *accidentally* logging a real API
token; it offers nothing against a deliberate exfiltrator. It also explains run 1: that marker was
all-uppercase, so it failed the base-64 rule's "two lowercase" condition.

**Scope.** This measures what real-time logs deliver — the Workers **trace event** shape, which is
also what Tail Workers consume and what the Workers Trace Events Logpush dataset is built from, so
`event.request.url` is the shared carrier. It does **not** establish what the *persisted* Workers
Logs store retains, nor whether that store applies the same redaction. **[UNDOCUMENTED]**

---

## workers.dev vs custom domain

We are on `*.workers.dev` today and move to a vanity domain pre-launch. The distinction is real and
Cloudflare draws it explicitly for analytics **[DOC]**
(<https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>):

> There are two graphical sources of information about your Workers traffic at a given time: Workers
> metrics and zone-based Workers analytics.

> Workers metrics aggregate request data for an individual Worker (if your Worker is running across
> multiple domains, and on `*.workers.dev`, metrics will aggregate requests across them).

> Zone analytics aggregate request data for all Workers assigned to any routes defined for a zone.

So:

- **Account-scoped surfaces follow the Worker** and apply identically on workers.dev and on a custom
  domain: Workers Logs, Workers Traces, real-time logs, Tail Workers, Workers Logpush (the
  `workers_trace_events` dataset is an *account* dataset), Workers metrics.
- **Zone-scoped surfaces attach to a zone**: zone analytics, the `http_requests` Logpush dataset
  (`ClientRequestURI`), Log Explorer zone datasets, Security Events. Custom Domains and Routes both
  require "An active Cloudflare zone" **[DOC]**
  (<https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>), and zone
  analytics is scoped to "routes defined for a zone".

**[INFERENCE, flagged]** A `workers.dev` request traverses no customer zone, so there is no zone for
zone-scoped logging to attach to — meaning today the `ClientRequestURI` sink is not in play, and the
move to a vanity domain **adds** it. I could find **no Cloudflare sentence stating this negative
directly**; it follows from the scoping language above, not from an explicit doc claim. Treat the
vanity-domain migration as *widening* the surface, and re-verify at that time.

### The sharpest zone surface: `firewallEventsAdaptive.clientRequestQuery` — NOT opt-in, NOT suppressible

**Added 2026-08-12 after the first draft.** The zone discussion above framed the added surfaces as
opt-in ones we can decline. **One of them is neither.** Every quote here was re-opened and verified
verbatim at its source URL before being recorded.

Security Events is powered by the `firewallEventsAdaptive` GraphQL dataset, which carries the query
string as **its own dedicated field**. The tutorial selects it directly and publishes a live response
proving it returns data **[DOC]**
(<https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-firewall-events/>):

```graphql
action
clientAsn
clientCountryName
clientIP
clientRequestPath
clientRequestQuery
datetime
source
userAgent
```

> `"clientRequestPath": "/%3Cscript%3Ealert()%3C/script%3E",`
> `"clientRequestQuery": "",`

Note the sample also shows attacker-controlled bytes preserved verbatim (URL-encoded, not sanitized).
The matching Logpush field is documented **[DOC]**
(<https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/firewall_events/>):

> **ClientRequestQuery** — "The query string requested by the visitor."

**It is available on every plan, including Free** **[DOC]**
(<https://developers.cloudflare.com/analytics/graphql-api/features/discovery/settings/>):

> Although we allow access to ALL plans for the essential datasets (like `httpRequestsAdaptiveGroups`,
> `firewallEventsAdaptive`, etc), users on larger plans benefit from an extended set of datasets and
> wider query limits.

Retention **[DOC]** (<https://developers.cloudflare.com/waf/analytics/security-events/>): Free 24 h ·
Pro 24 h · Business 3 days · Enterprise 30 days.

**Why this is worse than the other zone surfaces.** It is not a job we decline to create or a dataset
we decline to enable — it is a byproduct of any security product *acting* on the request: Managed
Rules, Bot Fight Mode, IP Access rules, UA blocking, rate limiting, Browser Integrity Check. So:

> **Blocking the exfiltration request still records the secret.** The defence writes the payload's
> bytes into a queryable store.

There is no off-switch short of having no security rule fire at all. This is the strongest argument
in this document for the reframe in [What ADR-0018 should say](#what-adr-0018-should-say): the
guarantee must be that **no secret exists to put in a URL**, because at least one URL-recording
surface cannot be configured away once the origin sits on a zone.

**[UNDOCUMENTED]** Whether Security Events / WAF fire at all for a `*.workers.dev` request. A
corpus-wide search of Cloudflare's own `waf` documentation export returns **zero** occurrences of
`workers.dev` (and zero of "custom domain"). So today's exposure is unknown rather than known-absent,
and the vanity-domain migration is where this surface becomes unambiguously live.

**Correction to an earlier draft claim:** the dataset name `workersOverviewAdaptiveGroups` does not
exist in Cloudflare's documentation. The real names are `workersOverviewRequestsAdaptiveGroups` and
`workersOverviewDataAdaptiveGroups`, neither of which has a published field list.

---

Practical consequence for the migration: putting the sandbox origin on a zone brings zone HTTP
request logging into scope. Logpush there is opt-in and its `field_names` can omit
`ClientRequestURI` **[DOC]**
(<https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/>), and Log Explorer
is opt-in per dataset and stoppable **[DOC]**
(<https://developers.cloudflare.com/log-explorer/faq/>):

> To stop log ingestion, disable any enabled datasets at both the account level and zone level.

Note **[DOC]** that Logpush *filters* are not redaction:

> Logpush filters act as a pass-through gate, not an exclusion list.

And **[UNDOCUMENTED]**: whether omitting a field from `field_names` affects what Cloudflare
*records and retains internally*, or only what is exported. Treat field omission as export hygiene,
not suppression.

---

## The always-on floor: Workers metrics

**[DOC]** Workers metrics is always on, with no documented opt-out anywhere. What it holds is
**counters and timings** — requests (total/success/error), subrequests, wall time, CPU time, memory,
invocation statuses, request duration. Reviewing the page's full section list, **there is no URL,
path, or query-string dimension in Workers metrics.**

> Worker metrics can be inspected for up to three months in the past in maximum increments of one
> week.

Three months is the longest retention of anything in this document — but of counters that carry no
payload bytes. This is the right shape of residual: we cannot turn it off, and it cannot leak the
secret.

Zone analytics, when we move to a zone, is scoped to 30 days and likewise presented as
subrequests / bandwidth / status codes / total requests. **[UNDOCUMENTED]** Whether Cloudflare's
internal edge analytics pipeline retains query strings anywhere a customer cannot see is not
documented. **[INFERENCE]** none available; state it as unverified residual.

**A correction worth recording**, because it is an easy misread: the Web Analytics FAQ sentence
"Cloudflare's edge analytics cannot be blocked because we can measure every request that is
received" appears under the question *"The analytics beacon is blocked by ad-blockers … Why is
that?"*. It means edge analytics cannot be blocked **by a visitor's ad-blocker**, contrasting with
the JS beacon. It is **not** a statement that a customer cannot disable analytics, and must not be
cited in an ADR as if it were.

---

## Can the Worker neutralise the sink?

**No.** Summarising the measured evidence and the documented field semantics:

| Idea | Verdict |
|---|---|
| Don't call `console.log` | **Ineffective** — invocation log is platform-generated; measured with `"logs": []` |
| Reject requests bearing a query string (400/405) | **Ineffective** — measured: 404 still emits the full URL |
| Redirect to a stripped URL | **Ineffective** — first request already recorded; adds a second event |
| Never read `url.search` in code | **Ineffective** — irrelevant to what the platform records |
| Rely on Cloudflare's redaction | **Ineffective** — measured: all-lowercase values pass through |
| `observability.logs.invocation_logs: false` | **Effective** for the retained record **[DOC]** |
| Decline Traces / Tail Workers / Logpush | **Effective** — all opt-in |
| Prevent `wrangler tail` observation | **No documented mechanism** |

**[UNDOCUMENTED], and worth stating plainly:** I could find no current Cloudflare page that states
where log-record production sits relative to Worker execution. The old
`/fundamentals/reference/http-request/` traffic-sequence page **404s**. The ordering conclusion here
rests on **[MEASURED]** behaviour and on documented field *semantics* (`ClientRequestURI` is defined
as the client's request), not on a Cloudflare ordering statement. An ADR should not cite an ordering
doc that does not exist.

---

## What ADR-0018 should say

The proposed clause fails because it is phrased as a property of *our code*, while the sink is a
property of the *platform*. Three amendments:

**1. Restate it as a deployment-configuration obligation, which is verifiable in a diff:**

> The sandbox origin's Worker MUST be deployed with invocation logging disabled
> (`observability.logs.invocation_logs: false`, or `observability.enabled: false`), MUST NOT enable
> Workers Traces, MUST NOT declare `tail_consumers`, MUST NOT enable Workers Logpush, and MUST NOT
> be included in any Logpush job or Log Explorer dataset that carries `ClientRequestURI` or the
> Workers Trace Events `Event` object. It MUST expose no endpoint that reflects, stores, or forwards
> request URLs or query strings.

Note this is a change we must actually make: the Worker currently ships `"observability": { "enabled": true }`.

**2. Name the residuals honestly rather than promising they are closed:**

- Cloudflare real-time logs (`wrangler tail` / dashboard Live logs) can surface request URLs to any
  authorized account member on demand. Not stored; no documented off-switch.
- Cloudflare's internal retention of request metadata is not fully documented; the customer-visible
  always-on surface (Workers metrics) carries no URL dimension, but Cloudflare-internal behaviour is
  unverified.
- Cloudflare's heuristic URL redaction MUST NOT be relied on: it is documented as heuristic and
  bypassable, and was measured to pass all-lowercase query values through verbatim.
- **Once the origin sits on a zone, `firewallEventsAdaptive.clientRequestQuery` records the query
  string on every plan including Free, with no off-switch** — it fires whenever any security product
  acts on the request, so *blocking the exfiltration request still records the secret*. Retention
  24 h (Free/Pro) to 30 days (Enterprise). This is the residual that most justifies amendment 3.

**3. Put the real invariant where it belongs — on the secret, not on the log.** The load-bearing
protection is the one already recorded in the map's memory: MyMemo auth is a **non-ambient,
origin-scoped bearer token**, so the sandbox origin's document has no secret to put in a URL in the
first place. `frame-src 'self'` permits same-origin navigation by construction and no logging
configuration changes that. The ADR should state that the design MUST NOT depend on URL
confidentiality, and that anything secret MUST be unreachable from the payload's origin — with the
logging configuration above as defence in depth, not as the primary control.

---

## Genuinely unclear or undocumented

Do not assert any of these in ADR-0018.

1. **Whether the persisted Workers Logs record retains the query string.** The stored message is
   documented as `<Method> <URL>`; the Query Builder only exemplifies `…request.path`. No exhaustive
   field list is published. *Most important open item.*
2. **Whether `url.full` on the incoming Fetch Handler trace span includes the query string.**
3. **Whether Workers Logs / Traces ingestion applies the tail redaction at all.** Redaction is
   documented only for the `TailRequest` JS API. Measured for real-time logs; unmeasured for the
   persisted store.
4. **Whether `invocation_logs: false` preserves `console.log` output.** Strongly implied by the
   log-type taxonomy; never stated.
5. **Whether `observability.enabled: true` cascades to `traces`.**
6. **`observability.logs.persist` / `logs.destinations` / `logs.enabled`** — present in the shipped
   wrangler schema (see below), absent from the configuration docs page.
7. **Any way to disable real-time logs / `wrangler tail`.** No documented toggle at any level.
8. **Whether a `workers.dev` Worker produces zone `http_requests` records.** Inferred negative from
   zone scoping; never stated.
9. **Whether Logpush `field_names` omission affects internal retention or only export.**
10. **The `Event` sub-schema of the `workers_trace_events` Logpush dataset** — undocumented.
11. **Explicit lifecycle ordering of Worker execution vs log-record production** — the traffic
    sequence page cited for this 404s; no replacement found.

---

## Appendix — the shipped wrangler schema

From the published npm artifact (`wrangler@4.122.0`, `config-schema.json`) — the shipped artifact,
not documentation about it. It documents keys the configuration page omits:

```
Observability:
  enabled: boolean               "If observability is enabled for this Worker"
  head_sampling_rate: number     "The sampling rate"
  logs:
    enabled: boolean
    head_sampling_rate: number
    invocation_logs: boolean     "Set to false to disable invocation logs"
    persist: boolean             "If logs should be persisted to the Cloudflare observability
                                  platform where they can be queried in the dashboard."  default: true
    destinations: string[]       default: []
  traces:
    enabled, head_sampling_rate, persist (default true), destinations
```

The schema declares defaults for `persist` and `destinations` but **no default for `enabled`** at
either level, so the artifact alone does not settle "what happens with no `observability` block".

Related **[DOC]**, from the Workers Logpush page — an alternative worth knowing for the vanity-domain
step, since it can avoid Cloudflare-side storage entirely:

> OpenTelemetry export supports both traces and logs, can be configured with `persist: false` to
> avoid storing logs and traces in Cloudflare, and works with any OTLP-compatible destination.

---

## Sources

All fetched 2026-08-12. Cloudflare docs pages were additionally read from the docs' own source
(`github.com/cloudflare/cloudflare-docs`, `production` branch) so quotes are verbatim rather than
rendered-and-summarised.

- Workers Logs — <https://developers.cloudflare.com/workers/observability/logs/workers-logs/>
- Real-time logs — <https://developers.cloudflare.com/workers/observability/logs/real-time-logs/>
- Tail Workers — <https://developers.cloudflare.com/workers/observability/logs/tail-workers/>
- Tail handler / `TailRequest` redaction — <https://developers.cloudflare.com/workers/runtime-apis/handlers/tail/>
- Workers Traces — <https://developers.cloudflare.com/workers/observability/traces/>
- Spans and attributes — <https://developers.cloudflare.com/workers/observability/traces/spans-and-attributes/>
- Query Builder — <https://developers.cloudflare.com/workers/observability/query-builder/>
- Workers Logpush — <https://developers.cloudflare.com/workers/observability/logs/logpush/>
- `workers_trace_events` fields — <https://developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/>
- Zone `http_requests` fields — <https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/zone/http_requests/>
- Logpush filters — <https://developers.cloudflare.com/logs/logpush/logpush-job/filters/>
- Logpush output options — <https://developers.cloudflare.com/logs/logpush/logpush-job/log-output-options/>
- Log Explorer FAQ — <https://developers.cloudflare.com/log-explorer/faq/>
- Metrics and analytics — <https://developers.cloudflare.com/workers/observability/metrics-and-analytics/>
- Web Analytics FAQ (context correction) — <https://developers.cloudflare.com/web-analytics/faq/>
- Wrangler configuration — <https://developers.cloudflare.com/workers/wrangler/configuration/>
- Custom Domains — <https://developers.cloudflare.com/workers/configuration/routing/custom-domains/>
- `cloudflare/workers-sdk` — `packages/workers-utils/src/config/environment.ts`,
  `packages/deploy-helpers/src/deploy/deploy.ts`
- `wrangler@4.122.0` published `config-schema.json`
