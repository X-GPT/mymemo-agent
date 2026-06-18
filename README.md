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

Each service reads its own `apps/<svc>/.env` (non-secret wiring stays inline in
`compose.yaml`). Create them from the examples:

```sh
cp apps/chat-api/.env.example       apps/chat-api/.env
cp apps/gateway/.env.example        apps/gateway/.env
cp apps/sandbox-daemon/.env.example apps/sandbox-daemon/.env
# Fill in apps/gateway/.env's ANTHROPIC_API_KEY. Keep the shared values identical
# across files: LLM_TOKEN_SECRET (chat-api + gateway), DAEMON_AUTH_TOKEN
# (chat-api + sandbox-daemon).
docker compose up --build
```

Send a turn (SSE stream). `X-Member-Code: demo-member` matches the seeded KB so
document search returns results:

```sh
curl -N http://localhost:3000/v1/chat \
  -H 'Content-Type: application/json' \
  -H 'X-Member-Code: demo-member' \
  -H 'X-Partner-Code: demo-partner' \
  -d '{"chatContent":"What is machine learning?"}'
```

The stream emits `conversation_id`, `run_id`, `sandbox_id`, `agent_session_id`,
then `text_delta` events, then `done`. You can pass `conversationId` back to reuse
the same thread id, but conversational *resume* (recalling prior turns) is not
wired through the endpoint yet — see the persistence note below.

### Session-transcript persistence across a sandbox recycle (MYM-27)

The daemon mirrors SDK transcripts to `AGENT_SESSION_STORE_ROOT=/session-store`,
a named volume that outlives the container. After a turn, the transcript is keyed
by member + conversation + agent session:

```sh
# After turn 1 above, the transcript is on the volume...
docker compose exec sandbox find /session-store -name '*.jsonl'
# /session-store/users/<sha256(member)>/conversations/<conversationId>/sessions/<agentSessionId>.jsonl

# Recreate the container (fresh writable layer; the named volume is kept).
# Use --force-recreate, NOT `restart`: `restart` reuses the same writable layer,
# so it wouldn't prove the volume — rather than the container — is what persists.
docker compose up -d --force-recreate sandbox

# ...still there on the fresh container, proving the volume holds it (the SDK's
# container-local copy under CLAUDE_CONFIG_DIR was discarded with the old layer):
docker compose exec sandbox find /session-store -name '*.jsonl'
```

This is what the harness demonstrates today: durable transcript **persistence**
across a sandbox recreate. Automatic conversational **resume** through the chat
endpoint is not wired yet — `chat.controller.ts` currently passes
`agentSessionId: null` (continuity is tracked in MYM-34), and the request body
has no `sessionId` field (it is `.strict()`). The agent-side resume path itself
is proven by `apps/sandbox-daemon` unit tests.

`docker compose down -v` wipes the volumes (KB seed + transcripts) to start clean.

### No bwrap (dev == prod)

The agent runs **directly** (`bun /workspace/agent.js`) with no bwrap wrapper —
the sandbox itself is the isolation boundary (the per-turn E2B sandbox in prod,
this container locally), and dev and prod share one spawn path
(`apps/sandbox-daemon/child-spawn.ts`). The agent still holds no provider key and
runs under the SDK's scoped tool surface; do not expose this container to
untrusted networks.

Unlike prod (a fresh per-turn E2B sandbox), the local `sandbox` is **one
long-lived container reused across turns and conversations**. Without per-turn
recycling or bwrap, a prompt-injected turn can read sibling
`users/*/conversations/*` transcripts on the shared `/session-store`, leave
stray background processes, or overwrite the baked `/workspace/*.js` bundles —
affecting later turns. That's fine for a **single-user dev harness** (it is not a
security boundary), but it is why the harness is for local testing only. (The
daemon-token-via-`/proc` exposure from dropping PID isolation does apply to prod
too and is tracked in MYM-35.)

