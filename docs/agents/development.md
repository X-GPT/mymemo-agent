# Development and verification

Use this guide when installing dependencies, changing TypeScript, running tests, or modifying the database layer.

## Package manager and scripts

This repository uses Bun workspaces. Run `bun install` at the repository root.

There is no repository-wide `build` or `typecheck` script. Do not treat Biome's `check` command as a TypeScript typecheck.

### Repository root

| Command | Purpose |
| --- | --- |
| `bun run test` | Run the root deployment/smoke tests followed by every workspace test suite |
| `bun run smoke:local` | Run the full local Conversation smoke suite against `localhost:3000` |
| `bun run terraform:fmt` | Format every Terraform root |
| `bun run terraform:validate` | Validate every initialized Terraform root |

### Workspace commands

Run these from the named workspace directory.

| Workspace | Commands |
| --- | --- |
| `apps/chat-api` | `bun run dev`, `bun run test`, `bun run check`, `bun run lint`, `bun run format`, `bun run db:migrate` |
| `apps/agent-worker` | `bun run dev`, `bun run test`, `bun run check`, `bun run template:build`, `bun run template:verify` |
| `apps/agentcore-canary-dispatch` | `bun run test`, `bun run check` |
| `apps/agentcore-canary-runtime` | `bun run test`, `bun run check` |
| `packages/agent-db` | `bun run test`, `bun run check`, `bun run db:generate` |
| `packages/live-text` | `bun run test`, `bun run check` |

`check`, `lint`, and `format` use write mode and may modify files. Inspect their diff after running them.

To build the chat-api container, run `docker build -f apps/chat-api/Dockerfile -t chat-api .` from the repository root. The Dockerfile requires the monorepo as its build context. This repository does not contain a Docker Compose file.

## Code style

- Biome is the formatter and linter.
- Use tab indentation and double quotes.
- Let Biome organize imports.
- In `apps/chat-api` and `apps/agent-worker`, `@/*` maps to `./src/*`.

## Single Drizzle instance invariant

`@mymemo/agent-db` exchanges Drizzle schema and SQL objects across package boundaries. Every workspace that uses `drizzle-orm` must resolve the same instance.

Bun can fork same-version `drizzle-orm` installations when their optional-peer contexts differ. Because `@electric-sql/pglite` is one such optional peer, every workspace that consumes `drizzle-orm` must also list `@electric-sql/pglite` as a dev dependency. Keep those peer sets aligned; do not cast around dual-instance type errors.

`packages/agent-db` owns the Drizzle schema and `packages/agent-db/drizzle/` migrations. `apps/chat-api/src/db/` contains thin bindings and runs the shared migrations through `MIGRATIONS_DIR`.
