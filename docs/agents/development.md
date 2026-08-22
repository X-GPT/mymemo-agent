# Development and verification

Use this guide when installing dependencies, changing TypeScript, running tests, or modifying the database layer.

## Package manager and scripts

This repository uses Bun workspaces. Run `bun install` at the repository root.

There is no repository-wide `build` or `typecheck` script. Do not treat Biome's `check` command as a TypeScript typecheck.

From `apps/chat-api`, use `bun run dev` for the hot-reload development server, `bun run lint` for lint fixes, and `bun run format` for formatting.

## Code style

- Biome is the formatter and linter.
- Use tab indentation and double quotes.
- Let Biome organize imports.
- In `apps/chat-api` and `apps/agent-worker`, `@/*` maps to `./src/*`.

## Single Drizzle instance invariant

`@mymemo/agent-db` exchanges Drizzle schema and SQL objects across package boundaries. Every workspace that uses `drizzle-orm` must resolve the same instance.

Bun can fork same-version `drizzle-orm` installations when their optional-peer contexts differ. Because `@electric-sql/pglite` is one such optional peer, every workspace that consumes `drizzle-orm` must also list `@electric-sql/pglite` as a dev dependency. Keep those peer sets aligned; do not cast around dual-instance type errors.

`packages/agent-db` owns the Drizzle schema and `packages/agent-db/drizzle/` migrations. chat-api imports that package directly; `apps/chat-api/src/db/migrate.ts` runs the shared migrations through `MIGRATIONS_DIR`.
