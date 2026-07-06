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

The prototype `gateway` and `sandbox` services are still defined in
`compose.yaml` but are **not** on the split-runtime path; they are retained until
Milestone 7 (ADR-0002) and are documented under "Retained prototype path" below.

### Run it

The split-runtime demo needs no secrets — chat-api opens its exposure gate via
`AGENT_EXPOSURE_BREAK_GLASS=true` (inline in `compose.yaml`). Bring up just the
two split apps; their deps (`postgres`, `migrate`) come along:

```sh
docker compose up --build chat-api agent-worker
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

### Retained prototype path (gateway + sandbox, until Milestone 7)

The subsections below describe the **prototype** `gateway` + `sandbox` services,
which the split-runtime demo above does not exercise. They still build and boot
(the `gateway` needs `apps/gateway/.env`'s `ANTHROPIC_API_KEY`; copy it from
`apps/gateway/.env.example`), and are deleted when Milestone 7 passes the full
local harness (ADR-0002).

#### Session-transcript persistence across a sandbox recycle (MYM-27)

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

#### No bwrap (dev == prod)

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

Within a single conversation, the reused workspace is still safe against a
**scope** leak: a conversation's document scope is immutable (see the technical
design doc's `conversationId` section). Documents hydrated into
`conversations/{id}/docs/` are always within that one scope, and the daemon
rejects (HTTP 409) any later turn whose scope differs, so a narrower turn can
never read documents a broader turn left on disk (MYM-39). The scope a
conversation is bound to is recorded in `conversations/{id}/scope.json`.

