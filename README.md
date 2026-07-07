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
back as SSE**. In Milestone 3 the worker runs a **synthetic** turn (one text
event per run), so the demo needs no provider, KB, or E2B credentials — a
`postgres` service backs the writable `mymemo_agent` DB, a one-shot `migrate`
service applies the `@mymemo/agent-db` migrations, and the two split-runtime apps
do the rest.

### Run it

The split-runtime demo needs no secrets — chat-api opens its exposure gate via
`AGENT_EXPOSURE_BREAK_GLASS=true` (inline in `compose.yaml`). Bring the stack up:

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

The stream emits `conversation_id`, `run_id`, one or more `text_delta` events
(the worker's synthetic response), then `done`. The prototype-era `sandbox_id`
and `agent_session_id` frames are **not** part of the split-runtime contract.
Re-POST `events` to the same `conversationId` for another turn.

This `compose.yaml` is a **manual** local stack for poking the running services
by hand; it is not what gates correctness. That is `e2e/integration.test.ts`,
which runs the same create → turn → assert-SSE flow with chat-api + agent-worker
as real processes against a real Postgres — no image build — on every PR (the
`integration` job in `.github/workflows/ci.yml`). Run it locally against any
migrated Postgres:

```sh
AGENT_DATABASE_URL=postgres://mymemo:mymemo@localhost:5432/mymemo_agent \
  DB_SSL=disable bun test e2e/integration.test.ts
```

`docker compose down -v` wipes the volumes (the KB seed + writable DB) to start clean.

