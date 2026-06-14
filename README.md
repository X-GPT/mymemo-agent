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
├── compose.yaml            # Local Docker Compose file
└── README.md               # This file
```

## Development

Each project can be developed independently. Navigate to the respective project directory and follow its setup instructions.

## Local Docker

`compose.yaml` builds and runs chat-api locally:

```sh
docker-compose up
```

