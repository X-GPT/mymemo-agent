# MyMemo Monorepo

This repository contains multiple projects for the MyMemo ecosystem.

## Projects

The repository is a Bun workspace. See [AGENTS.md](./AGENTS.md) for the
architecture and trust boundaries.

| App | Location | Role |
|-----|----------|------|
| **chat-api** | `apps/chat-api/` | AI chat service; owns Conversation resources, strict Run admission, retained Redis Stream consumption, history, and artifact delivery |
| **agent-worker** | `apps/agent-worker/` | Split-runtime Fargate worker; claims Runs, holds worker-only credentials, executes Claude Agent SDK turns, and publishes standard AG-UI events |

Shared libraries live under `packages/` (e.g. `@mymemo/agent-db`).

**Setup:**
```bash
bun install          # from the repo root, installs all workspaces
cd apps/chat-api
bun run dev
```

See [apps/chat-api/README.md](./apps/chat-api/README.md) for chat-api documentation.

## Repository Structure

```
.
├── apps/                   # Deployable applications
│   ├── chat-api/           # AI chat service (admits Runs, relays retained SSE)
│   └── agent-worker/       # Split-runtime worker (claims + runs turns)
├── packages/               # Shared libraries (e.g. @mymemo/agent-db)
├── AGENTS.md               # Architecture & agent guidance
├── compose.yaml            # Local end-to-end harness (chat-api + agent-worker + postgres)
└── README.md               # This file
```

## Development

Each project can be developed independently. Navigate to the respective project directory and follow its setup instructions.

## Local end-to-end harness

`compose.yaml` runs the split-runtime path locally: **chat-api admits a Run →
agent-worker claims and processes it → chat-api relays the retained standard
AG-UI Stream as SSE**. The worker runs a real Claude Agent SDK turn through
OpenRouter and an E2B workspace. Postgres backs permanent Conversation history;
Redis provides the temporary per-Run delivery and reconnect lane.

### Run it

Before starting the harness:

- Build the worker's E2B template as described in
  `apps/agent-worker/e2b-template/README.md`.
- Export `OPENROUTER_API_KEY` and `E2B_API_KEY`. Optionally override
  `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, or
  `WORKER_E2B_TEMPLATE`.
- Provide AWS credentials that can access the shared Terraform state, provision
  the dev artifact bucket, and get, put, and delete its objects. Compose mounts
  `~/.aws` read-only; to use the repository's usual profile, export
  `AWS_PROFILE=mymemo` and authenticate it first when needed (for example,
  `aws sso login --profile mymemo`). To use exported credentials instead,
  leave `AWS_PROFILE` unset and set `AWS_ACCESS_KEY_ID`,
  `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials,
  `AWS_SESSION_TOKEN`.

Provision the shared dev infrastructure once, and re-apply it whenever
`infra/dev` changes. These commands use the `mymemo` profile; omit the
`AWS_PROFILE=mymemo` prefix when using exported credentials:

```sh
AWS_PROFILE=mymemo terraform -chdir=infra/dev init
AWS_PROFILE=mymemo terraform -chdir=infra/dev apply
```

This separate dev Terraform state owns the fixed
`mymemo-agent-local-artifacts` bucket, blocks public access, enforces
bucket-owner ownership and encryption, and expires objects after seven days.

Compose passes the developer AWS credentials only to the two trusted runtimes.
The worker's structurally restricted sandbox environment does not pass them to
the E2B sandbox. This shared developer credential is a local-harness convenience
only; deployed chat-api and agent-worker tasks keep their separate
least-privilege artifact roles. Chat-api opens its exposure gate locally via
`AGENT_EXPOSURE_BREAK_GLASS=true` in `compose.yaml`.

Bring the stack up with one command:

```sh
docker compose up --build
```

Create a Conversation, then admit a strict AG-UI Run to stream the turn. First
create the Conversation (its document scope is frozen at creation):

```sh
curl -sS http://localhost:3000/v1/conversations \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{}'
# → {"conversationId":"<uuid>","scope":"general"}
```

Then generate client-owned Run and message UUIDs and POST a standard
`RunAgentInput` to the returned `conversationId` (SSE stream):

```sh
curl -N http://localhost:3000/v1/conversations/<conversationId>/runs \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{"threadId":"<conversationId>","runId":"<run-uuid>","messages":[{"id":"<message-uuid>","role":"user","content":"Hello, split runtime."}],"tools":[],"context":[]}'
```

The stream emits standard AG-UI `RUN_STARTED`, Assistant text lifecycle and
Tool events, then one terminal event. SSE frames carry data only. Reconnect at
`GET /v1/conversations/<conversationId>/runs/<runId>/events`; every attach
rebuilds the active Run from the beginning. POST another client-owned Run id to
the same Conversation for the next turn.

This `compose.yaml` is a **manual** local stack for poking the running services
by hand; it is not what gates correctness. That is `e2e/integration.test.ts`,
which runs the create → admit → stream/reconnect flow with chat-api and a
deterministic test-only Stream producer on every PR.
Run the integration locally against its configured dependencies:

```sh
AGENT_DATABASE_URL=postgres://mymemo:mymemo@localhost:5432/mymemo_agent \
  DB_SSL=disable bun test e2e/integration.test.ts
```

### Live runtime smoke

The credentialed smoke's `core` suite drives the real worker across three Runs
of one Conversation. The first two prove Agent-session resume, Workspace
persistence, exact Assistant commits, and byte-exact durable replay. The third
writes a unique Downloadable artifact, lists it after `RUN_FINISHED`, obtains a fresh
signed URL, and downloads the exact attachment without identity headers. The
local `full` suite adds one interrupted Run and two seeded searchable-document
Runs that prove inventory, search, docs-cache load, file read-back, and durable
Tool history.

With the local compose stack running, execute the full pre-merge suite with one
command:

```sh
bun run smoke:local
```

For production, run `scripts/deploy/prod_smoke.sh` from inside the VPC with
`AGENT_SMOKE_BASE_URL` configured and the checked-in `codex-smoke` identity
allowlisted in Statsig. OpenRouter and E2B credentials stay in the deployed
worker; the smoke caller receives none of them. To check only the default-closed
gate, set `AGENT_SMOKE_EXPECT_GATE_CLOSED=true`.

`AGENT_SMOKE_SUITE` defaults to `core`; `full` is the local superset used by
`smoke:local`. See [the two-target smoke verification guide](./docs/verification/e2e-smoke.md)
for suite contents, target selection, and deterministic harness tests.

### Worker image check

Every PR builds the final production-pruned worker image and runs this same
credential-free gate; release deployment also runs it after build and before
push:

```sh
docker build --platform linux/amd64 \
  -f apps/agent-worker/Dockerfile \
  -t mymemo-agent-worker:image-check .
scripts/smoke/agent-worker-image-check.sh mymemo-agent-worker:image-check
```

The container check resolves the SDK-owned glibc Claude CLI and executes its
`--version` command with no network or runtime credentials.

`docker compose down -v` wipes the volumes (the KB seed + writable DB) to start clean.
