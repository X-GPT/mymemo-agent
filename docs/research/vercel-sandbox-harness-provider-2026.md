# Vercel Sandbox provider for `HarnessAgent`

**Research date: 2026-08-26.** Resolves
[#587](https://github.com/X-GPT/mymemo-agent/issues/587) for the
[HarnessAgent-on-Vercel-Sandbox map (#585)](https://github.com/X-GPT/mymemo-agent/issues/585).
Versions read: `@ai-sdk/sandbox-vercel` **1.0.91**, `@ai-sdk/harness` **1.0.91**,
`@ai-sdk/harness-claude-code` **1.0.94** (vercel/ai `main` at
[`56d492f`](https://github.com/vercel/ai/commit/56d492f61652af7bad16f56ed33cf41924ef5496),
2026-08-26, and the same versions pinned in the repo's
[`codex/prototype-harness-agent` lockfile](https://github.com/X-GPT/mymemo-agent/commit/6cdfc3d2f95944d13399c720ea10033ee4ead2c7));
`@vercel/sandbox` **3.1.0** (released 2026-08-21; source from vercel/sandbox `main` at
[`92535f1`](https://github.com/vercel/sandbox/commit/92535f1c72644524537f86daecaa649eae520513)).
Vercel doc pages cite their own `last_updated` dates (2026-08-11 to 2026-08-26). All harness
packages are marked experimental
([README](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/README.md)).

This note does not repeat the `HarnessAgent` surface
([`ai-sdk-harness-agent-api-2026.md`](ai-sdk-harness-agent-api-2026.md)) or the bridge-vs-host
analysis and AgentCore image gaps
([`ai-sdk-harness-agentcore-sandbox-feasibility-2026.md`](ai-sdk-harness-agentcore-sandbox-feasibility-2026.md)).
It pins down what the **Vercel** provider specifically does.

## Short answer

- **Package/import.** `import { createVercelSandbox } from '@ai-sdk/sandbox-vercel'`. There
  is no `vercelSandbox` export; the factory returns a `HarnessV1SandboxProvider`
  (`providerId: 'vercel-sandbox'`). Options are the `@vercel/sandbox` `Sandbox.create()`
  parameters minus `onResume`, plus `name`; or `{ sandbox }` to wrap a caller-owned sandbox.
  Provider defaults: `timeout` 30 min (SDK default is 5), `runtime: 'node24'`. Claude Code
  needs `ports: [<n>]`.
- **Auth.** `@vercel/sandbox` resolves credentials as: explicit `token`+`teamId`+`projectId`
  (all three or none) → `VERCEL_OIDC_TOKEN` (team/project decoded from the JWT) → an
  interactive device flow only on a dev TTY. **It does not read `VERCEL_TOKEN`,
  `VERCEL_TEAM_ID`, or `VERCEL_PROJECT_ID` from the environment.** chat-api runs on ECS, so
  MyMemo must pass an access token, team ID, and project ID to `createVercelSandbox()`; the
  `vercel env pull` OIDC token expires after 12 hours and is only auto-refreshed on Vercel.
- **Lifecycle.** Fresh `createSession` → per-recipe template sandbox via
  `Sandbox.getOrCreate` (bootstrap baked in `onCreate`, stopped to publish a snapshot) → a
  per-session `Sandbox.create({ source: { type: 'snapshot' } })` named
  `ai-sdk-harness-session-<sessionId>`. `detach()` leaves the microVM running (until its
  `timeout`); `stop()` kills the bridge then `sandbox.stop()` (auto-snapshot, sandboxes are
  persistent by default); `destroy()` = `stop()` + `sandbox.delete()`;
  `createSession({ resumeFrom })` → `Sandbox.get({ name })`, which auto-resumes a stopped
  sandbox from its last snapshot on the first SDK call.
- **Limits/pricing (Pro, `iad1`).** No idle timeout; a wall-clock session `timeout` (default
  5 min, extendable, max 24 h Pro / 45 min Hobby). 2 vCPU + 4 GB default, max 8 vCPU / 16 GB
  Pro. 10,000 concurrent sandboxes Pro (10 Hobby). Regions `iad1` (default), `sfo1`, `cle1`,
  `cdg1`; snapshots are region-bound. Egress `allow-all` by default; `deny-all` and domain
  allowlists with credential-injecting `transform` rules are available. $0.128/active-CPU-hour,
  $0.0212/GB-hour provisioned memory, $0.60 per million creations, $0.15/GB egress (downloads
  such as npm installs are free), $0.00263/GB-month snapshot storage.
- **Bootstrap.** The Claude recipe writes `.harness-bootstrap/claude-code/` and runs
  `pnpm install --frozen-lockfile` of `@anthropic-ai/claude-code` 2.1.213 +
  `@anthropic-ai/claude-agent-sdk` 0.3.213, then `claude --version`. On Vercel this runs
  **once per recipe identity** inside the template's `onCreate` and is snapshotted;
  per-session sandboxes fork from the snapshot and only hit the marker check.
  `prepareHarnessSandboxTemplate()` does the same ahead of time from CI. Registry egress is
  only needed while the template is created. No primary source states the first-turn
  wall-clock; it is unmeasured and belongs to the #590 spike.
- **Credentials to the CLI.** `createClaudeCode({ auth: 'direct', env })` reads
  `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN`/`ANTHROPIC_API_KEY` from the **host** process
  env, merges `settings.env` over them, and — because the Vercel session supports
  `addRequestTransformations` — replaces each credential with an `aisdkhc_…` placeholder
  before sending the env to the bridge. The Vercel firewall swaps the placeholder for the
  real bearer token on requests to the `ANTHROPIC_BASE_URL` host (TLS terminated with the
  per-sandbox CA). The real OpenRouter key never enters the sandbox. The env reaches the
  `claude` CLI via the Agent SDK `query({ options: { env } })`; Bash-tool children inherit it
  unless `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is set, so Bash can read the placeholder and
  can still *spend* the key by calling the allowed host from inside the sandbox.
- **`auth: 'auto'` trap.** Auto mode treats `VERCEL_OIDC_TOKEN` as an AI Gateway credential
  and routes Claude at the Vercel AI Gateway. With the OIDC token present for sandbox auth,
  MyMemo must pin `auth: 'direct'` (the prototype does).

## 1. Package, import, and options

`@ai-sdk/sandbox-vercel` 1.0.91 exports exactly `createVercelSandbox`, `VercelSandboxProvider`,
and the `VercelSandboxSettings` type
([index](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/index.ts)). It
depends on `@ai-sdk/harness`, `@ai-sdk/provider-utils`, and `@vercel/sandbox` `^2.0.1 || ^3.0.0`,
and requires Node `>=22`
([package.json](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/package.json)).
The AI SDK docs pair it with the Claude Code adapter because "bridge-backed harnesses such as
Claude Code and Codex require using real network sandbox like `@ai-sdk/sandbox-vercel`"
([HarnessAgent docs](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/02-harness-agent.mdx)).

`VercelSandboxSettings` is a union of two shapes
([source L42-59](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L42-L59)):

- `{ sandbox: Sandbox }` — wrap an already-created `@vercel/sandbox` instance. The caller owns
  its lifecycle; the provider's `stop()` and `destroy()` are no-ops.
- `Sandbox.create()` parameters (the SDK type is aliased directly, minus `onResume`), plus
  `name` to override the auto-derived template name. So `runtime`, `image`, `source`, `env`,
  `ports`, `timeout`, `resources.vcpus`, `region`, `failoverRegions`, `networkPolicy`,
  `persistent`, `snapshotExpiration`, `keepLastSnapshots`, `tags`, `fetch`, and the
  credential fields `token`/`teamId`/`projectId` all pass straight through
  (there is no `mounts` option in `@vercel/sandbox` 3.1.0; an earlier revision of
  this note listed one in error)
  ([SDK reference, `Sandbox.create`](https://vercel.com/docs/sandbox/sdk-reference#sandbox.create)).

Provider-imposed defaults
([source L61-66, L136-145](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L61-L66)):

- `timeout` defaults to **30 minutes** ("The `@vercel/sandbox` SDK defaults to 5 minutes which
  is too short for multi-step workflows — the VM expires between steps").
- When neither `runtime`, `image`, nor a snapshot `source` is given, `runtime: 'node24'` is
  set explicitly so the adapter's default stays stable across `@vercel/sandbox` v2 and v3
  (v3 otherwise defaults to the `vercel/sandbox/universal` image). Support for v3 landed in
  sandbox-vercel 1.0.87
  ([CHANGELOG](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/CHANGELOG.md)).

The Claude Code adapter uses the first port in `sandbox.ports` for its WebSocket bridge and
throws `HarnessCapabilityUnsupportedError` if none is exposed: "Create the sandbox with
`ports: [<port>]` or pass `createClaudeCode({ port })`"
([adapter L1196-1205](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1196-L1205)).
The endpoint is `sandbox.domain(port)` rewritten to `wss:`
([network session L50-78](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L50-L78)),
i.e. a **public** Vercel URL; the bridge authenticates the host with `BRIDGE_CHANNEL_TOKEN`, a
random 32-byte token rotated per spawn
([adapter L1054-1064](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1054-L1064),
[bridge transport L358](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts#L358)).
Vercel bills "all traffic to and from exposed ports"
([pricing, Network](https://vercel.com/docs/sandbox/pricing#network)), so the bridge stream
is metered egress.

The provider's tool-safe session runs every `run()` as `bash -c <command>` and every `spawn()`
as `runCommand({ detached: true })`
([session L39-45, L59-75](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox-session.ts#L39-L75)).

MyMemo's prototype uses `createVercelSandbox({ runtime: 'node24', ports: [4000] })` with
`createClaudeCode({ auth: 'direct', model })`
([prototype](https://github.com/X-GPT/mymemo-agent/blob/codex/prototype-harness-agent/apps/agentcore-runtime/prototype-harness-agent.ts)).

## 2. Authentication

### What the provider checks

`createVercelSandbox()` performs no I/O; credentials are resolved by `@vercel/sandbox` inside
`Sandbox.create`/`getOrCreate`/`get`. Any 401/403 or Vercel auth error is rethrown as
`HarnessSandboxAuthenticationError` with the message "Vercel Sandbox authentication failed.
Set VERCEL_OIDC_TOKEN, or pass token, teamId, and projectId to createVercelSandbox(), then
verify that they can access Vercel Sandbox."
([source L323-357](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L323-L357)).
`hasConfiguredCredentials` is true when `process.env.VERCEL_OIDC_TOKEN` is set, a wrapped
`sandbox` is supplied, or all of `token`, `teamId`, `projectId` are passed.

### What `@vercel/sandbox` 3.1.0 actually does

[`getCredentials()`](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/utils/get-credentials.ts#L81-L153):

1. If `token`, `teamId`, and `projectId` are **all** passed as parameters, use them. Passing
   one or two throws `Missing credentials parameters to access the Vercel API: …`.
2. Otherwise call `@vercel/oidc`'s `getVercelOidcToken()` (reads `VERCEL_OIDC_TOKEN`) and
   decode `project_id` and `owner_id` from the JWT payload as `projectId`/`teamId`
   ([L59-79, L166-187](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/utils/get-credentials.ts#L59-L79)).
3. If that fails and `shouldPromptForCredentials()` is true (`NODE_ENV !== 'production'`, `CI`
   unset, stdin/stdout are TTYs), start a browser device-authorization flow and cache the
   result for the process
   ([dev-credentials L12-19, L135-140](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/utils/dev-credentials.ts#L12-L19));
   otherwise throw `LocalOidcContextError` / `VercelOidcContextError`.

There is no code path that reads `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, or `VERCEL_PROJECT_ID`
from the environment. Vercel's docs list those names only as suggested shell variables that
you "then pass … to `Sandbox.create()`"
([Authentication](https://vercel.com/docs/sandbox/concepts/authentication#access-tokens)).
With the harness provider that means
`createVercelSandbox({ token, teamId, projectId, … })`.

### Where each value comes from

| Value | Source | Notes |
| --- | --- | --- |
| `VERCEL_OIDC_TOKEN` | `vercel link` + `vercel env pull` → `.env.local` | "The token expires after 12 hours"; on Vercel-hosted compute "Vercel manages token expiration automatically" ([Authentication](https://vercel.com/docs/sandbox/concepts/authentication#vercel-oidc-token-recommended)). |
| `token` | A Vercel access token with access to the team ([REST API](https://vercel.com/docs/rest-api#creating-an-access-token)) | Vercel's recommendation for "External CI/CD" and "Non-Vercel hosting". |
| `teamId` | Team settings ([find your team ID](https://vercel.com/docs/accounts#find-your-team-id)) | `team_…`. |
| `projectId` | Project general settings ([project ID](https://vercel.com/docs/project-configuration/general-settings#project-id)) | `prj_…`. Sandboxes, snapshots, and VCR images are project-scoped; names are unique per project ([Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#sandbox-names)). |

chat-api runs as an ECS service
([`infra/terraform/cloudwatch.tf`](../../infra/terraform/cloudwatch.tf)), not on Vercel, so
production must use the access-token triple stored the way `docs/agents/configuration.md`
handles other secrets. The OIDC path is only viable for local runs.

## 3. Lifecycle mapping

The contract the provider implements is
[`HarnessV1SandboxProvider`](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-sandbox-provider.ts#L10-L70):
`createSession({ sessionId?, identity?, onFirstCreate?, abortSignal? })` and optional
`resumeSession({ sessionId })`. `sessionId` makes naming deterministic "so a future call to
`resume` (potentially from a different process) can find the same sandbox"; `identity` is a
"stable identity for snapshot-based reuse"; `onFirstCreate` is "called exactly once per
identity, on fresh creation".

| Harness call | `HarnessAgent` / session behavior | Vercel provider call | Vercel Sandbox effect |
| --- | --- | --- | --- |
| `agent.createSession()` (fresh) | Computes the bootstrap plan and calls `provider.createSession({ sessionId, identity, onFirstCreate })` ([harness-agent L351-374](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L351-L374)) | Template: `Sandbox.getOrCreate({ name: 'ai-sdk-harness-<identity>', persistent: true, snapshotExpiration: 0, onCreate: bootstrap })`; if no `currentSnapshotId`, `template.stop()` and read `snapshot.id` (or poll `Sandbox.get({ resume: false })` for up to 30 s). Session: `Sandbox.create({ ...params, source: { type: 'snapshot', snapshotId }, name: 'ai-sdk-harness-session-<sessionId>' })` ([provider L147-243](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L147-L243)) | One persistent, never-expiring template sandbox per recipe identity (its snapshot is the fork source), plus one persistent session sandbox per harness session. The snapshot ID is cached in a process-global `Map` keyed by template name ([L283-321](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L283-L321)). |
| `session.detach()` | Returns resume state with live bridge coordinates; "The runtime and sandbox keep running; this local session handle becomes unusable" ([session L399-427](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts#L399-L427)) | None | The microVM keeps running and billing until its `timeout` (provider default 30 min) elapses; then Vercel stops the session and, because the sandbox is persistent, snapshots it ([Concepts, Stopping](https://vercel.com/docs/sandbox/concepts#stopping-a-sandbox)). |
| `session.stop()` | `doStop` waits up to 5 s for the bridge then `proc.kill()`; returns resume state; then `sandboxSession.stop()` when harness-owned ([session L435-461](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts#L435-L461), [adapter L1925-1945](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1925-L1945)) | `sandbox.stop()` ([network session L114-117](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L114-L117)) | Session stops; filesystem auto-snapshotted ("`stop()` … For persistent sandboxes, the resolved value also includes metadata for the snapshot captured during shutdown", [SDK reference](https://vercel.com/docs/sandbox/sdk-reference#sandbox.stop)). |
| `session.destroy()` | `doDestroy` kills the bridge; then `sandboxSession.destroy()` ([session L468-480](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts#L468-L480)) | `sandbox.stop()` then `sandbox.delete()` ([L119-123](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts#L119-L123)) | Sandbox and its sessions are deleted. "Its snapshots survive the deletion … and they keep incurring storage charges" until they expire ([Persistence, Delete](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#delete-a-sandbox)). |
| `createSession({ sessionId, resumeFrom })` | Requires `provider.resumeSession`; else `HarnessCapabilityUnsupportedError` ([harness-agent L332-350](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L332-L350)) | `Sandbox.get({ name: 'ai-sdk-harness-session-<sessionId>' })` ([provider L246-270](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L246-L270)) | "The handle is returned immediately; the SDK starts a new session on the next call that needs a running VM" from the most recent snapshot, with a fresh `timeout` ([Persistence, Resume](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#resume-where-you-left-off)). The adapter then tries to attach to a still-live bridge, else respawns it in replay or rerun mode (see the feasibility note's restart ladder). |
| `createSession({ sandboxSession })` | Caller owns the sandbox; harness never stops/destroys it ([HarnessAgent docs](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/02-harness-agent.mdx)) | `createVercelSandbox({ sandbox })` → `ownsLifecycle: false` | `stop()`/`destroy()` are no-ops. |
| Start failure after sandbox acquisition | `cleanupAfterStartFailure` → `sandboxSession.stop()` if harness-owned ([L955-963](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L955-L963)) | `sandbox.stop()` | Stopped, snapshotted, **not deleted**. |

Points that matter for MyMemo:

- **Session sandboxes are always persistent.** The fork strips `runtime`, `image`, `source`,
  and `persistent` from the settings before `Sandbox.create`
  ([L222-228](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts#L222-L228)),
  and `@vercel/sandbox` v2+ defaults `persistent` to `true`
  ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference#sandbox.create)). Every
  `stop()` (explicit or by timeout) therefore writes a snapshot. `snapshotExpiration` and
  `keepLastSnapshots` **are** forwarded, so MyMemo can bound storage (Vercel recommends
  `keepLastSnapshots: { count: 1 }`,
  [Persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#default-snapshot-expiration-and-retention)).
- **Abandoned sandboxes.** Nothing in the harness deletes a session sandbox except
  `destroy()`. A detached-then-forgotten session stops at `timeout`, snapshots, and Vercel
  "removes sandboxes that can't resume from a snapshot after 14 days of inactivity"; a
  persistent one with a live snapshot stays until its snapshot expires (30 days after last
  use by default) ([Persistence, Sandbox retention](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#sandbox-retention)).
  This is the "cleanup of abandoned sandboxes" item the map defers.
- **`resumeFrom` is persistence-dependent.** After `stop()` the sandbox is stopped; resume
  works only because the sandbox is persistent and its snapshot is still available (and in the
  same region, [Regions and snapshots](https://vercel.com/docs/sandbox/concepts/regions#regions-and-snapshots)).
- **What survives `stop()`.** The adapter deliberately keeps the installed CLI, bridge, the
  per-session `.agent-runs/<sessionId>/bridge` state, and the work dir under the sandbox's
  default working directory (`/vercel/sandbox` on `node24`) so they "survive both detach →
  attach/replay and stop → snapshot → resume cycles"
  ([bootstrap comment L5-16](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-bootstrap.ts#L5-L16),
  [Runtimes](https://vercel.com/docs/sandbox/concepts/runtimes)).
- **Per-process snapshot cache.** A new chat-api process re-runs `Sandbox.getOrCreate` on the
  template name; that "retrieves it without resuming it" and returns the existing
  `currentSnapshotId`, so no re-bootstrap
  ([Persistence, Get or create](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#get-or-create-idempotent)).

## 4. Limits, network policy, and pricing

All figures from Vercel's [pricing and quotas](https://vercel.com/docs/sandbox/pricing)
(`last_updated: 2026-08-21`) unless noted.

| Dimension | Hobby | Pro / Enterprise |
| --- | --- | --- |
| Active CPU (`iad1`) | 5 h/month included | $0.128/hour |
| Provisioned memory (`iad1`) | 420 GB-h/month included | $0.0212/GB-hour, 1-minute minimum |
| Sandbox creations | 5,000/month | $0.60 per 1M |
| Data transfer (egress + exposed-port traffic; downloads free) | 20 GB/month | $0.15/GB |
| Snapshot storage | 15 GB lifetime | $0.002630137/GB-month (Pro), $0.08/GB-month (Enterprise, as printed) |
| Concurrent sandboxes | 10 | 10,000 |
| Max session duration | 45 min | 24 h |
| Max vCPU / memory | 4 / 8 GB | 8 / 16 GB (Enterprise 32 / 64 GB) |
| vCPU allocation rate | 20 → 40/min | 150 → 5,000/min (resets after 10 idle min) |
| Control plane (commands, file ops) | 1,000 req/min | 10,000 req/min (Enterprise 100,000) |
| Deletions | 20 req/s | 20 req/s |

- **Compute shape.** "You can provision 1 or an even number of vCPUs between 2 and 32 …
  The default is 2 vCPUs"; "Each vCPU includes 2 GB of memory"; 32 GB ephemeral NVMe; up to
  15 open ports ([Resource limits](https://vercel.com/docs/sandbox/pricing#resource-limits)).
  Active CPU excludes time "waiting for I/O (such as network requests, database queries, or AI
  model calls)", which is most of a Claude turn.
- **Timeout semantics.** "The default timeout is 5 minutes"; "The maximum duration applies to
  a single session, not to the sandbox itself. The limit resets every time a sandbox stops and
  resumes" ([Runtime limits](https://vercel.com/docs/sandbox/pricing#runtime-limits)).
  `sandbox.extendTimeout(ms)` extends the live deadline up to the plan max
  ([SDK reference](https://vercel.com/docs/sandbox/sdk-reference#sandbox.extendtimeout)).
  Vercel's KB confirms the timeout is wall-clock and there is no separate idle timeout
  ([Duration and persistence guide](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)).
  The harness never calls `extendTimeout`; a detached Conversation dies at 30 minutes unless
  MyMemo passes a larger `timeout` or extends it itself.
- **Pro billing.** "All Sandbox usage on Pro plans is charged against your $20/month credit"
  then at the rates above; Hobby pauses creation after the allotment
  ([Billing information](https://vercel.com/docs/sandbox/pricing#billing-information)).
- **Regions.** `iad1` (default), `sfo1`, `cle1`, `cdg1`; chosen per sandbox via `region` or a
  project default; failover regions are Pro/Enterprise only. "Snapshots can't be moved between
  regions", and creating from a snapshot in another region fails with
  `snapshot_region_mismatch` ([Regions](https://vercel.com/docs/sandbox/concepts/regions)).
  MyMemo's AWS estate is `us-east-1`-adjacent; `iad1` is the natural choice and must be fixed
  for the whole template + session set.
- **Isolation and image.** "Each sandbox runs in its own Firecracker microVM with a dedicated
  kernel"; `sudo` is available; images boot Ubuntu 26.04, custom VCR images, or snapshots
  ([Concepts](https://vercel.com/docs/sandbox/concepts)). The legacy `node24` runtime the
  provider defaults to is Amazon Linux 2023 with Node 24, `npm`, `pnpm`, `git`, user
  `vercel-sandbox`, cwd `/vercel/sandbox`; runtimes are "deprecated" since 2026-08-07 but "keep
  working for existing code" ([Runtimes](https://vercel.com/docs/sandbox/concepts/runtimes)).
  The `vercel/sandbox/universal` image (Node 24 LTS, Python 3.14, "coding agents") is the v3
  default and is opt-in via `image`
  ([Images](https://vercel.com/docs/sandbox/concepts/images#vercel-managed-images)).
- **Network policy.** Three modes: `allow-all` ("Default policy … unrestricted access to the
  public Internet"), `deny-all` (blocks everything including DNS), and user-defined allowlists
  of domains (SNI-matched, wildcards per label) and CIDRs with denied CIDRs taking precedence.
  A domain rule may carry `transform` (credentials brokering) or `forwardURL` (proxying), for
  which the firewall terminates TLS using a per-sandbox CA that is pre-trusted via
  `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, etc. Policies can be set at creation and updated on a
  running sandbox ([Firewall](https://vercel.com/docs/sandbox/concepts/firewall),
  [Proxy CA certificates](https://vercel.com/docs/sandbox/concepts#proxy-ca-certificates)).
  `createVercelSandbox({ networkPolicy })` passes the native shape through, and the harness
  session exposes `setNetworkPolicy`, `setRequestTransformations`, and
  `addRequestTransformations` for mid-session changes
  ([README](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/README.md)).

## 5. Claude Code bootstrap in a fresh Vercel Sandbox

### The recipe

`getClaudeCodeBootstrap()` returns a `HarnessV1Bootstrap` with `bootstrapDir:
'.harness-bootstrap/claude-code'`, four files (`package.json`, `pnpm-lock.yaml`,
`pnpm-workspace.yaml`, `bridge.mjs`), and two commands:
`pnpm install --frozen-lockfile --store-dir .pnpm-store` then
`./node_modules/.bin/claude --version`
([claude-code-bootstrap.ts L17-51](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-bootstrap.ts#L17-L51)).
The bridge manifest pins `@anthropic-ai/claude-agent-sdk` **0.3.213**,
`@anthropic-ai/claude-code` **2.1.213**, `@modelcontextprotocol/sdk` 1.29.0, `ws` 8.21.0,
`zod` 4.4.3 ([bridge/package.json](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/package.json)).
The lockfile resolves platform-specific `claude-agent-sdk-linux-x64` binaries, which is what
the `node24` (AL2023 x64) runtime needs. `pnpm` is present on `node24`
([Runtimes](https://vercel.com/docs/sandbox/concepts/runtimes)).

The recipe identity is a "deterministic 16-char hex identity derived from the recipe's
content"; any content change (e.g. a new adapter release bumping the pinned CLI) produces a
new identity and therefore a new template. After a successful run the framework writes
`.harness-bootstrap/claude-code/.bootstrap-<identity>.ok`; subsequent `applyBootstrapRecipe`
calls check the marker and return
([bootstrap-recipe.ts L12-15, L62-84](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/bootstrap-recipe.ts#L12-L15)).
`sandboxConfig.onBootstrap` + `bootstrapHash` fold into the same identity when MyMemo needs
extra template setup ([sandbox-bootstrap.ts L96-108](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/sandbox-bootstrap.ts#L96-L108)).

### Where it runs on Vercel

Because the provider receives `identity` and `onFirstCreate`, the recipe runs inside
`Sandbox.getOrCreate({ …, onCreate })` for the template sandbox and is captured in its snapshot;
`onCreate` "runs once when a sandbox is freshly created … awaited before `Sandbox.getOrCreate`
resolves"
([Persistence, Lifecycle hooks](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes#lifecycle-hooks)).
Each harness session then forks from that snapshot and `HarnessAgent` re-applies the recipe as
"a cheap no-op based on just a marker check"
([harness-agent L383-407](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts#L383-L407)).
So the `pnpm install` runs once per adapter version per project/region, not per Conversation.
The feasibility note's concern about "installing packages from the public registry on first
customer traffic" applies only to the first session after a template invalidation.

`prepareHarnessSandboxTemplate({ harness, sandboxProvider, sandboxConfig })` performs the same
`createSession({ identity, onFirstCreate })` without a `sessionId`, applies the recipe, and
stops the temporary session; "the snapshot/template state persists … for Vercel: as the
`currentSnapshotId` of the named template sandbox"
([prepare-harness-sandbox-template.ts L12-72](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/prepare-harness-sandbox-template.ts#L12-L72)).
Vercel documents it as a CI/deploy step
([HarnessAgent docs, Prepare Reusable Sandboxes](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/02-harness-agent.mdx)).
Note the temporary session is itself a persistent fork with an auto-generated name that is
stopped (snapshotted) and not deleted.

### Registry egress

Under the default `allow-all` policy `registry.npmjs.org` is reachable, and "Data your sandbox
downloads from the internet, such as packages … is free"
([pricing, Network](https://vercel.com/docs/sandbox/pricing#network)). If MyMemo sets a
restrictive `networkPolicy` at creation, it applies to the template too, so the allowlist must
include the npm registry (and any `onBootstrap` sources) or template creation fails. Because
the same settings object feeds both template and forks, a tighter per-session policy is best
applied after creation via `setNetworkPolicy` rather than in `createVercelSandbox()`.

### First-turn wall-clock

No primary source publishes a number, and the prototype commit did not record one. The
components are:

1. **Cold (template missing):** `Sandbox.getOrCreate` boot + write four files + `pnpm install`
   of Claude Code 2.1.213 with its native binary + `claude --version` + `template.stop()`
   (snapshot publish; the provider polls up to 30 s for the snapshot ID) + fork.
2. **Warm (template exists):** fork from snapshot ("Resuming from a snapshot is even faster
   than starting a fresh sandbox", sandboxes "start in milliseconds",
   [Concepts](https://vercel.com/docs/sandbox/concepts#how-sandboxes-work)) + `mkdir -p` +
   `spawn node bridge.mjs` + bridge advertises its port (adapter waits up to
   `startupTimeoutMs`, default 120,000 ms,
   [adapter L127](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L127))
   + `sandbox.update({ networkPolicy })` for credential brokering + first model round-trip via
   OpenRouter.

Measuring both paths is a stated deliverable for the
[#590 spike](https://github.com/X-GPT/mymemo-agent/issues/590).

## 6. How `createClaudeCode({ env })` reaches the Claude CLI

### Resolution on the host

`ClaudeCodeHarnessSettings.env` is "Environment variables for the Claude Code process. These
values are merged over the sandbox bridge process environment"
([settings L101-104](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L101-L104)).
On every start the adapter builds
`claudeEnvironment = { ...resolveClaudeCodeEnv(settings.auth), …, ...settings.env }`
([L866-879](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L866-L879)):

- `auth: 'direct'` → `pickAnthropic` reads `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and
  `ANTHROPIC_BASE_URL` from the **host** `process.env` (falling back to the CLI's
  `apiKeyHelper` from `~/.claude/settings.json`)
  ([claude-code-auth.ts L185-204](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-auth.ts#L185-L204)).
- `auth: 'auto'` (default) → gateway first: `apiKey = AI_GATEWAY_API_KEY || VERCEL_OIDC_TOKEN`
  ([ai-gateway-auth.ts L11-14](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/ai-gateway-auth.ts#L11-L14));
  when set, it emits `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `AI_GATEWAY_BASE_URL`, and
  `ANTHROPIC_BASE_URL` pointing at the Vercel AI Gateway
  ([L242-259](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-auth.ts#L242-L259)).
  Since `VERCEL_OIDC_TOKEN` is the local sandbox credential, `auto` silently reroutes the
  model call away from OpenRouter; pin `auth: 'direct'`.

### Credential brokering (Vercel path)

Because `VercelNetworkSandboxSession` implements `addRequestTransformations`, the adapter
takes the brokering branch
([L880-909](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L880-L909)):

1. For each of `AI_GATEWAY_API_KEY`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` present in
   `claudeEnvironment`, generate a placeholder `aisdkhc_<43 base64url chars>` (or whatever
   `credentialForwarding` returns for the placeholder)
   ([credential-forwarding.ts L31-60](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/credential-forwarding.ts#L31-L60),
   [sandbox-credential-brokering.ts L4-12](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/sandbox-credential-brokering.ts#L4-L12)).
   The placeholder map is stored in the resume state (`sandboxCredentialEnvironment`) and
   reused on resume so the same rule re-applies idempotently.
2. `sandboxClaudeEnvironment = { ...claudeEnvironment, ...placeholders }` — the sandbox never
   sees the real values.
3. Build one `HarnessV1RequestTransformation` per credential: `match.host` = hostname of
   `ANTHROPIC_BASE_URL` (default `api.anthropic.com`), `match.path.startsWith` = the base URL
   path (`/api` for `https://openrouter.ai/api`), `match.headers` = exact
   `Authorization: Bearer <placeholder>` (or `x-api-key: <placeholder>`), `transform.headers` =
   the real header
   ([claude-code-auth.ts L20-66](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-auth.ts#L20-L66),
   [createCredentialRequestTransformation L36-58](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/sandbox-credential-brokering.ts#L36-L58)).
   The exact-header match is the "harden credential brokering to only apply with correct
   ephemeral secret" change in harness-claude-code 1.0.93
   ([CHANGELOG](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/CHANGELOG.md)).
4. `VercelNetworkPolicyManager.addRequestTransformations` reads the current policy
   (`allow-all` by default), composes `{ allow: { '*': [], 'openrouter.ai': [ { match, transform } ] } }`
   (a rule host is active when the allowed pattern `*` contains it), and calls
   `sandbox.update({ networkPolicy })`
   ([policy manager L98-200, L302-360, L414-470](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-policy-manager.ts#L302-L360)).
   Vercel then terminates TLS for that host and rewrites the header
   ([Firewall, Credentials brokering](https://vercel.com/docs/sandbox/concepts/firewall#credentials-brokering)).

Sandboxes without request-transformation support fall back to forwarding the real values with a
console warning ([L910-916](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L910-L916));
Vercel's docs state the same rule
([Claude Code adapter docs, Authentication](https://github.com/vercel/ai/blob/main/content/providers/02-ai-sdk-harnesses/01-claude-code.mdx)).

### Delivery to the bridge and the CLI

The bridge process itself is spawned with only `BRIDGE_CHANNEL_TOKEN`, `BRIDGE_WS_PORT`, and
`HOME` (when skills are used) over the sandbox's default env
([L1057-1064, L1098-1101](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1057-L1064)).
`sandboxClaudeEnvironment` travels in the `start` message over the WebSocket
(`env: sandboxClaudeEnvironment`, [L1167](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts#L1167)),
and the bridge passes it to the Agent SDK as
`query({ options: { env: { ...procEnv, ...start.env } } })`
([bridge/index.ts L17, L339-344](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/index.ts#L339-L344)).
The Agent SDK's `env` option "replaces the subprocess environment instead of merging with
`process.env`", which is why the bridge merges `procEnv` first
([Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)).

Inside the CLI, `ANTHROPIC_BASE_URL` overrides the API endpoint, `ANTHROPIC_AUTH_TOKEN` is
sent as `Authorization: Bearer <value>`, and `ANTHROPIC_API_KEY` as `X-Api-Key`
([Claude Code env vars](https://code.claude.com/docs/en/env-vars),
[Connect to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)). The
OpenRouter request therefore leaves the sandbox as
`POST https://openrouter.ai/api/v1/messages` with `Authorization: Bearer aisdkhc_…`, which
matches the brokering rule.

### Do Bash-tool children inherit it?

Yes by default. Claude Code documents `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`: "Set to `1` to strip
Anthropic and cloud provider credentials from subprocess environments (Bash tool, hooks, MCP
stdio servers). The parent Claude process keeps these credentials for API calls, but child
processes cannot read them … On Linux, this also runs Bash subprocesses in an isolated PID
namespace so they cannot read host process environments via `/proc`"
([env vars](https://code.claude.com/docs/en/env-vars)); the sandboxing page adds "There is no
built-in credential deny list"
([Sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing#protect-credentials)).
The adapter does not set it.

Consequences for the map's stage-1 trust statement ("the model credential **is** reachable
from prompt-injected Bash"):

- What Bash can *read* is the placeholder, not the OpenRouter key. Exfiltrating
  `$ANTHROPIC_AUTH_TOKEN` yields `aisdkhc_…`, which is useless outside this sandbox.
- What Bash can still *do* is spend the key: a `curl https://openrouter.ai/api/... -H
  "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN"` from inside the sandbox is rewritten by the
  same firewall rule. Brokering scopes the credential to one host from one microVM; it does
  not stop in-sandbox abuse. `createClaudeCode({ env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } })`
  removes even the placeholder from Bash, hooks, and MCP children at no cost to the model path.

## 7. Implications for #585

- Configure `createVercelSandbox({ token, teamId, projectId, runtime: 'node24', ports: [n],
  region: 'iad1', timeout, snapshotExpiration, keepLastSnapshots: { count: 1 } })` and
  `createClaudeCode({ auth: 'direct', env: { CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } })`.
  Set `ANTHROPIC_BASE_URL`/`ANTHROPIC_AUTH_TOKEN` on the chat-api process from
  `OPENROUTER_BASE_URL`/`OPENROUTER_API_KEY` as the prototype does.
- Run `prepareHarnessSandboxTemplate()` in the release pipeline so no user turn pays for
  `pnpm install`; the template is keyed by adapter version, so each dependency bump creates a
  new template and leaves the old one (never-expiring snapshot) behind until deleted.
- Decide the sandbox retention policy: `detach()` alone leaves microVMs running to their
  `timeout`, and `stop()`/timeouts accumulate snapshots. Only `destroy()` deletes a sandbox.
- The "credential reachable from Bash" risk is narrower than the map states; revise it to
  "usable from inside the sandbox against the allowed host" and ticket the scrub flag.
- Snapshot region-binding means the region is a project-level decision, not per Conversation.

## Sources

- `@ai-sdk/sandbox-vercel` 1.0.91: [README](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/README.md), [package.json](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/package.json), [vercel-sandbox.ts](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox.ts), [vercel-network-sandbox-session.ts](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-sandbox-session.ts), [vercel-sandbox-session.ts](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-sandbox-session.ts), [vercel-network-policy-manager.ts](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/src/vercel-network-policy-manager.ts), [CHANGELOG](https://github.com/vercel/ai/blob/main/packages/sandbox-vercel/CHANGELOG.md)
- `@ai-sdk/harness` 1.0.91: [harness-v1-sandbox-provider.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/v1/harness-v1-sandbox-provider.ts), [harness-agent.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent.ts), [harness-agent-session.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/harness-agent-session.ts), [prepare-harness-sandbox-template.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/prepare-harness-sandbox-template.ts), [bootstrap-recipe.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/bootstrap-recipe.ts), [sandbox-bootstrap.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/agent/internal/sandbox-bootstrap.ts), [credential-forwarding.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/credential-forwarding.ts), [sandbox-credential-brokering.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/sandbox-credential-brokering.ts), [ai-gateway-auth.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/utils/ai-gateway-auth.ts), [bridge/index.ts](https://github.com/vercel/ai/blob/main/packages/harness/src/bridge/index.ts)
- `@ai-sdk/harness-claude-code` 1.0.94: [claude-code-harness.ts](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-harness.ts), [claude-code-auth.ts](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-auth.ts), [claude-code-bootstrap.ts](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/claude-code-bootstrap.ts), [bridge/package.json](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/package.json), [bridge/index.ts](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/src/bridge/index.ts), [CHANGELOG](https://github.com/vercel/ai/blob/main/packages/harness-claude-code/CHANGELOG.md)
- AI SDK docs (same commit): [HarnessAgent](https://github.com/vercel/ai/blob/main/content/docs/03-ai-sdk-harnesses/02-harness-agent.mdx) (published at [ai-sdk.dev](https://ai-sdk.dev/docs/ai-sdk-harnesses/harness-agent)), [Claude Code adapter](https://github.com/vercel/ai/blob/main/content/providers/02-ai-sdk-harnesses/01-claude-code.mdx) ([ai-sdk.dev](https://ai-sdk.dev/providers/ai-sdk-harnesses/claude-code))
- `@vercel/sandbox` 3.1.0: [get-credentials.ts](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/utils/get-credentials.ts), [dev-credentials.ts](https://github.com/vercel/sandbox/blob/main/packages/vercel-sandbox/src/utils/dev-credentials.ts), [releases](https://github.com/vercel/sandbox/releases)
- Vercel Sandbox docs: [overview](https://vercel.com/docs/vercel-sandbox), [authentication](https://vercel.com/docs/sandbox/concepts/authentication), [concepts](https://vercel.com/docs/sandbox/concepts), [persistence](https://vercel.com/docs/sandbox/concepts/persistent-sandboxes), [snapshots](https://vercel.com/docs/sandbox/concepts/snapshots), [firewall](https://vercel.com/docs/sandbox/concepts/firewall), [regions](https://vercel.com/docs/sandbox/concepts/regions), [runtimes](https://vercel.com/docs/sandbox/concepts/runtimes), [images](https://vercel.com/docs/sandbox/concepts/images), [pricing and quotas](https://vercel.com/docs/sandbox/pricing), [JS SDK reference](https://vercel.com/docs/sandbox/sdk-reference), [duration and persistence guide](https://vercel.com/kb/guide/vercel-sandbox-duration-and-persistence)
- Claude Code docs: [environment variables](https://code.claude.com/docs/en/env-vars), [connect to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect), [sandboxed Bash tool](https://code.claude.com/docs/en/sandboxing), [Agent SDK TypeScript reference](https://code.claude.com/docs/en/agent-sdk/typescript)
- MyMemo: [prototype-harness-agent.ts](https://github.com/X-GPT/mymemo-agent/blob/codex/prototype-harness-agent/apps/agentcore-runtime/prototype-harness-agent.ts) (commit `6cdfc3d`), [#585](https://github.com/X-GPT/mymemo-agent/issues/585), [#590](https://github.com/X-GPT/mymemo-agent/issues/590)
