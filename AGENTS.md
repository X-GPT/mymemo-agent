# AGENTS.md

MyMemo is a Bun-workspace TypeScript monorepo for an AI Conversation service, its trusted execution runtimes, and a shared Postgres run-state layer.

## Repository essentials

- Package manager: **Bun**. Install dependencies with `bun install` and run package scripts with `bun run`.
- The repository currently defines no `build` or `typecheck` script. Use the scoped verification commands in [Development and verification](docs/agents/development.md).
- Read only the guidance relevant to the task; the linked documents contain the detail intentionally omitted here.
- Surface materially different interpretations before editing, keep changes scoped to the request, and verify with the narrowest relevant checks before broadening.

## Progressive guidance

- [Working agreements](docs/agents/working-agreements.md) — scope, ambiguity, and verification expectations
- [Development and verification](docs/agents/development.md) — commands, formatting, tests, and the Drizzle dependency invariant
- [System architecture](docs/agents/architecture.md) — service responsibilities, persistence, and module boundaries
- [Chat API behavior](docs/agents/chat-api.md) — routes, Run admission, history, artifacts, and Scopes
- [Agent worker runtime](docs/agents/agent-worker.md) — Run serving, SDK streams, E2B, Searchable documents, and artifacts
- [Database and concurrency](docs/agents/database.md) — schema ownership, fenced stores, and Postgres-only race tests
- [Security boundaries](docs/agents/security.md) — identity, exposure gating, sandbox trust, and secret ownership
- [Configuration and operations](docs/agents/configuration.md) — environment variables and AWS CLI conventions
- [Domain language and ADR usage](docs/agents/domain.md) — required terminology and architectural decisions
- [Issue tracker](docs/agents/issue-tracker.md) and [triage labels](docs/agents/triage-labels.md) — GitHub workflow
- [Refactor audit](docs/agents/refactor-audit.md) — resolved contradiction and deletion candidates from the progressive-disclosure refactor
