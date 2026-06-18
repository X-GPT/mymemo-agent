# MyMemo Monorepo

This repository contains multiple projects for the MyMemo ecosystem.

## Projects

The repository is a Bun workspace. See [AGENTS.md](./AGENTS.md) for the
architecture and trust boundaries.

| App | Location | Role |
|-----|----------|------|
| **chat-api** | `apps/chat-api/` | AI chat service; orchestrates a per-user E2B sandbox per turn |
| **sandbox-daemon** | `apps/sandbox-daemon/` | In-sandbox HTTP daemon; bundled and shipped into E2B, spawns the agent per turn |
| **gateway** | `apps/gateway/` | Control plane; the only service holding the real `ANTHROPIC_API_KEY` and the read-only KB `DATABASE_URL`. Verifies the per-turn token, proxies to Anthropic, and serves scope-enforced document search/fetch |
| **mymemo-docs** | `apps/mymemo-docs/` | CLI on the sandbox PATH that the agent uses to reach the gateway's document endpoints |

Shared libraries live under `packages/` (e.g. `@mymemo/llm-token`).

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
│   ├── chat-api/           # AI chat service (orchestrator)
│   ├── sandbox-daemon/     # In-sandbox daemon shipped into E2B
│   ├── gateway/            # Control plane: Anthropic proxy + scoped document reader
│   └── mymemo-docs/        # In-sandbox docs CLI
├── packages/               # Shared libraries (e.g. @mymemo/llm-token)
├── AGENTS.md               # Architecture & agent guidance
├── compose.yaml            # Local end-to-end harness (chat-api + daemon + gateway + postgres)
└── README.md               # This file
```

## Development

Each project can be developed independently. Navigate to the respective project directory and follow its setup instructions.

## Local end-to-end harness

`compose.yaml` runs the full product path — **chat-api → sandbox-daemon →
gateway** — locally, without E2B. E2B can't run on dev machines (no
`E2B_API_KEY`, no userns on macOS), so the `sandbox` service replaces the E2B
sandbox with a long-lived container that runs the same daemon + agent bundles
(with the `claude` and `mymemo-docs` binaries baked in), and a `postgres`
service stands in for the MyMemo KB so the gateway can boot and serve document
search.

chat-api selects this path via `SANDBOX_PROVIDER=local`
(`apps/chat-api/src/features/sandbox-orchestration/`): instead of leasing a fresh
E2B sandbox per turn, it points at the `sandbox` container over the compose
network and only health-checks it. The default `SANDBOX_PROVIDER=e2b` is
unchanged.

### Run it

```sh
cp .env.example .env          # then fill in ANTHROPIC_API_KEY + the two secrets
docker compose up --build
```

Send a turn (SSE stream). `X-Member-Code: demo-member` matches the seeded KB so
document search returns results:

```sh
curl -N http://localhost:3000/api/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{"chatContent":"What is machine learning?"}'
```

The stream emits `session_id`, `sandbox_id`, `text_delta` events, then `done`.
Persist the `sessionId` to resume the conversation on a later turn (pass it back
as `sessionId`).

### Session-transcript persistence across a sandbox recycle (MYM-27)

The daemon mirrors SDK transcripts to `AGENT_SESSION_STORE_ROOT=/session-store`,
a named volume that outlives the container:

```sh
# Turn 1 — note the returned sessionId
curl -N http://localhost:3000/api/v1/chat -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' -H 'X-Partner-Code: demo-partner' \
  -d '{"chatContent":"My favorite color is teal. Remember it."}'

docker compose restart sandbox      # wipes the in-container ~/.claude; the volume survives

# Turn 2 with the same sessionId — the agent recalls "teal"
curl -N http://localhost:3000/api/v1/chat -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' -H 'X-Partner-Code: demo-partner' \
  -d '{"chatContent":"What is my favorite color?","sessionId":"<sessionId-from-turn-1>"}'
```

`docker compose down -v` wipes the volumes (KB seed + transcripts) to start clean.

### No bwrap (dev == prod)

The agent runs **directly** (`bun /workspace/agent.js`) with no bwrap wrapper —
the sandbox itself is the isolation boundary (the per-turn E2B sandbox in prod,
this container locally), and dev and prod share one spawn path
(`apps/sandbox-daemon/child-spawn.ts`). The agent still holds no provider key and
runs under the SDK's scoped tool surface; do not expose this container to
untrusted networks.

