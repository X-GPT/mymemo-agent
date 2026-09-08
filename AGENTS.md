# AGENTS.md

MyMemo is a Bun-workspace TypeScript monorepo for a Lambda front, trusted
AgentCore Runtime, and Code Interpreter Hand. Read [CONTEXT.md](CONTEXT.md)
for domain language and ADR-0035 for the architecture.

- Use **Bun**: `bun install`, `bun run test`.
- No root build or typecheck script exists. Follow [verification](docs/agents/development.md).
- State material assumptions before editing; keep changes scoped and verify narrowly first.

## Progressive guidance

- [Working agreements](docs/agents/working-agreements.md)
- [Development and verification](docs/agents/development.md)
- [System architecture](docs/agents/architecture.md)
- [Chat API behavior](docs/agents/chat-api.md)
- [AgentCore Runtime](docs/agents/agentcore-runtime.md)
- [Database and concurrency](docs/agents/database.md)
- [Security boundaries](docs/agents/security.md)
- [Configuration and operations](docs/agents/configuration.md)
- [Domain language and ADR usage](docs/agents/domain.md)
- [Issue tracker](docs/agents/issue-tracker.md) and [triage labels](docs/agents/triage-labels.md)
