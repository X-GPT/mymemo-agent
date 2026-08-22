# MyMemo Monorepo

This repository contains multiple projects for the MyMemo ecosystem.

## Projects

The repository is a Bun workspace. See [AGENTS.md](./AGENTS.md) for the
architecture and trust boundaries.

| App | Location | Role |
|-----|----------|------|
| **chat-api** | `apps/chat-api/` | AI chat service; owns Conversation resources, strict Run admission, producer-buffered Live Stream attachment, history, and artifact delivery |
| **agent-worker** | `apps/agent-worker/` | Split-runtime Fargate worker; claims Runs, holds worker-only credentials, executes Claude Agent SDK turns, and publishes standard AG-UI events including validated display-only UI payloads |
| **agentcore-runtime** | `apps/agentcore-runtime/` | Request-oriented AgentCore Runtime using shared Run-serving behavior |
| **agentcore-local-dispatch-bridge** | `apps/agentcore-local-dispatch-bridge/` | Development-only durable-outbox bridge to the local Runtime |

Shared libraries live under `packages/` (e.g. `@mymemo/agent-db`).

**Setup:**
```bash
bun install          # from the repo root, installs all workspaces
cd apps/chat-api
bun run dev
```

See [the chat API guide](./docs/agents/chat-api.md) for chat-api documentation.

## Repository Structure

```
.
├── apps/                   # Deployable applications
│   ├── chat-api/           # AI chat service (admits Runs, attaches SSE)
│   └── agent-worker/       # Split-runtime worker (claims + runs turns)
├── packages/               # Shared libraries (e.g. @mymemo/agent-db)
├── AGENTS.md               # Architecture & agent guidance
├── compose.yaml            # Local AgentCore Runtime stack
└── README.md               # This file
```

## Development

Each project can be developed independently. Navigate to the respective project directory and follow its setup instructions.

## Runtime verification

Conversation creation and the checked-in Compose stack are AgentCore-only.
`bun run smoke:local` proves the complete local Conversation flow from public
admission through the durable outbox, development bridge, and real local
Runtime.

The credential-free PR suite covers durable AgentCore acquisition and
stream/reconnect behavior through the shared Run-serving seam. The process
suite adds public HTTP admission, real Postgres and Redis, Runtime invocation,
interruption, lifecycle conflicts, Tool errors, and Reclamation:

```sh
bun test e2e/relay-failure-matrix.integration.test.ts
AGENT_DATABASE_URL=postgres://… DB_SSL=disable bun test e2e/integration.test.ts
```

### Live runtime smoke

The credentialed smoke's `core` suite drives the real worker across three Runs
of one Conversation. The first two prove Agent-session resume, Workspace
persistence, exact Assistant commits, and byte-exact durable replay. The third
writes a unique Downloadable artifact, lists it after `RUN_FINISHED`, obtains a fresh
signed URL, and downloads the exact attachment without identity headers. The
local `full` suite adds one interrupted Run and two seeded searchable-document
Runs that prove inventory, search, docs-cache load, file read-back, and durable
Tool history. `bun run smoke:local` runs that complete `full` suite against
Postgres, Redis, the local Dispatch bridge, the real Runtime, and a disposable
S3-compatible artifact store.

For production, run `scripts/deploy/prod_smoke.sh` from inside the VPC with
`AGENT_SMOKE_BASE_URL` configured and the checked-in `codex-smoke` identity
targeted in the exposure Statsig gate. The wrapper
requires the public creation response to report `agentcore` before admitting a
Run. OpenRouter and E2B credentials stay in the deployed worker; the smoke caller
receives none of them. To check only the default-closed gate, set
`AGENT_SMOKE_EXPECT_GATE_CLOSED=true`.

`AGENT_SMOKE_SUITE` defaults to `core`; `full` remains the local superset. See
[the two-target smoke verification guide](./docs/verification/e2e-smoke.md)
for suite contents, target selection, and deterministic harness tests.

### Worker image check

A PR that touches the worker image's inputs — the Dockerfile and the trees it
COPYs, any workspace manifest, the lockfile, `.dockerignore`, or the check
script — builds the final production-pruned image and runs this same
credential-free gate (`.github/workflows/worker-image.yml`, path-filtered so
unrelated PRs skip it). Release deployment runs it unconditionally, after
build and before push:

```sh
docker build --platform linux/amd64 \
  -f apps/agent-worker/Dockerfile \
  -t mymemo-agent-worker:image-check .
scripts/smoke/agent-worker-image-check.sh mymemo-agent-worker:image-check
```

The container check resolves the SDK-owned glibc Claude CLI and executes its
`--version` command with no network or runtime credentials.
