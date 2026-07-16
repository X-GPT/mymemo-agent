# MyMemo Monorepo

This repository contains multiple projects for the MyMemo ecosystem.

## Projects

The repository is a Bun workspace. See [AGENTS.md](./AGENTS.md) for the
architecture and trust boundaries.

| App | Location | Role |
|-----|----------|------|
| **chat-api** | `apps/chat-api/` | AI chat service; owns conversation creation, queued run insertion, and durable SSE projection over Postgres `run_events` |
| **agent-worker** | `apps/agent-worker/` | Split-runtime Fargate worker; claims queued runs, holds the worker-only credentials (KB, OpenRouter, E2B), and runs the Claude Agent SDK turn |

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
│   ├── chat-api/           # AI chat service (queues runs, projects SSE)
│   └── agent-worker/       # Split-runtime worker (claims + runs turns)
├── packages/               # Shared libraries (e.g. @mymemo/agent-db)
├── AGENTS.md               # Architecture & agent guidance
├── compose.yaml            # Local end-to-end harness (chat-api + agent-worker + postgres)
└── README.md               # This file
```

## Development

Each project can be developed independently. Navigate to the respective project directory and follow its setup instructions.

## Local end-to-end harness

`compose.yaml` runs the split-runtime path locally: **chat-api queues a run →
agent-worker claims and processes it → chat-api projects the run's durable events
back as SSE**. The worker runs a real Claude Agent SDK turn through OpenRouter
and an E2B workspace. A `postgres` service backs the writable `mymemo_agent` DB,
a one-shot `migrate` service applies the `@mymemo/agent-db` migrations, and the
two split-runtime apps do the rest.

### Run it

Before starting the harness:

- Build the worker's E2B template as described in
  `apps/agent-worker/e2b-template/README.md`.
- Export `OPENROUTER_API_KEY` and `E2B_API_KEY`. Optionally override
  `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, or
  `WORKER_E2B_TEMPLATE`.
- Provide AWS credentials that may create and configure the dev bucket and
  get, put, and delete its objects. Compose mounts `~/.aws` read-only; to use
  the repository's usual profile, export `AWS_PROFILE=mymemo` and authenticate
  it first when needed (for example, `aws sso login --profile mymemo`). To use
  exported credentials instead, leave `AWS_PROFILE` unset and set
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for temporary credentials,
  `AWS_SESSION_TOKEN`.

The one-shot `artifact-bucket` service creates
`mymemo-agent-local-artifacts` if it is missing, blocks public access, enforces
bucket-owner ownership, and expires objects after seven days. The fixed bucket
name must be available to the AWS account behind the selected credentials.

Compose passes these AWS credentials only to the bucket initializer and the
two trusted runtimes. The worker's structurally restricted sandbox environment
does not pass them to the E2B sandbox. This shared developer credential is a
local-harness convenience only; deployed chat-api and agent-worker tasks keep
their separate least-privilege artifact roles. Chat-api opens its exposure gate
locally via `AGENT_EXPOSURE_BREAK_GLASS=true` in `compose.yaml`.

Bring the stack up with one command:

```sh
docker compose up --build
```

Create a conversation, then append a `user.message` event to stream the turn.
First create the conversation (its document scope is frozen at creation):

```sh
curl -sS http://localhost:3000/v1/conversations \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{}'
# → {"conversationId":"<uuid>","scope":"general"}
```

Then append an event to the returned `conversationId` (SSE stream):

```sh
curl -N http://localhost:3000/v1/conversations/<conversationId>/events \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{"type":"user.message","text":"Hello, split runtime."}'
```

The stream emits `conversation_id`, `run_id`, one or more durable `text_commit`
events from the real agent, then `done`. The prototype-era `sandbox_id` and
`agent_session_id` frames are **not** part of the split-runtime contract.
Re-POST `events` to the same `conversationId` for another turn.

This `compose.yaml` is a **manual** local stack for poking the running services
by hand; it is not what gates correctness. That is `e2e/integration.test.ts`,
which runs the same create → turn → assert-SSE projection flow with chat-api and
a deterministic test-only event-writer process against a real Postgres on every
PR.
Run the projection integration locally against any migrated Postgres:

```sh
AGENT_DATABASE_URL=postgres://mymemo:mymemo@localhost:5432/mymemo_agent \
  DB_SSL=disable bun test e2e/integration.test.ts
```

### Live runtime smoke

The credentialed smoke drives the real worker across two runs of one
conversation. The first run creates an opaque file in E2B and returns only its
SHA-256; the second must resume the prior agent session, reconnect to the same
workspace, read the file, and stream contents matching that hash before the
`done` outcome. Against the local compose stack:

```sh
AGENT_SMOKE_BASE_URL=http://localhost:3000 \
  AGENT_SMOKE_EXPECT_GATE_CLOSED=false \
  bun run scripts/smoke/agent-conversation-smoke.ts
```

For production, run `scripts/deploy/prod_smoke.sh` from inside the VPC with
`AGENT_SMOKE_BASE_URL` configured and the checked-in `codex-smoke` identity
allowlisted in Statsig. OpenRouter and E2B credentials stay in the deployed
worker; the smoke caller receives none of them. To check only the default-closed
gate, set `AGENT_SMOKE_EXPECT_GATE_CLOSED=true`.

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
