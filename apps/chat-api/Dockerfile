FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Prune the context to just the workspace manifests. --frozen-lockfile needs
# every member's package.json (the root lockfile describes them all), and
# deriving the set this way means a new workspace member needs no Dockerfile
# edit. Only package.json files plus the root lockfile survive, so the install
# layers below still cache on manifest content alone.
FROM base AS manifests
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

# Install dependencies from the pruned manifests.
FROM base AS install
COPY --from=manifests /usr/src/app /temp/dev
RUN cd /temp/dev && bun install --frozen-lockfile

# Scope the production install to chat-api and its workspace deps. Without the
# filter, bun installs every workspace member's prod deps into the hoisted root
# node_modules — chat-api would ship agentcore-runtime's ~459MB Claude Agent SDK
# (plus e2b) that it never imports. --filter=chat-api keeps only the reachable
# closure (chat-api + agent-db + live-text), cutting node_modules ~660MB → ~145MB.
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod && bun install --frozen-lockfile --production --filter=chat-api

# Assemble the source for the release image. Tests are NOT run here — CI
# (.github/workflows/ci.yml) is the test gate; the image build just produces the
# runtime artifact.
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY apps/chat-api/ apps/chat-api/
COPY packages/agent-db/ packages/agent-db/
COPY packages/live-text/ packages/live-text/
COPY package.json .

# Development-only composition. The production release stage below copies only
# src/, so this always-open local entrypoint cannot ship in the release image.
FROM base AS local
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/apps/chat-api apps/chat-api
COPY --from=prerelease /usr/src/app/packages/agent-db packages/agent-db
COPY --from=prerelease /usr/src/app/packages/live-text packages/live-text
COPY --from=prerelease /usr/src/app/package.json .
WORKDIR /usr/src/app/apps/chat-api
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "local/index.ts" ]

# Final release image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/apps/chat-api/src apps/chat-api/src
COPY --from=prerelease /usr/src/app/apps/chat-api/package.json apps/chat-api/
COPY --from=prerelease /usr/src/app/apps/chat-api/tsconfig.json apps/chat-api/
# The shared writable-DB data layer. Ships its `drizzle/` migrations so the image
# can run `bun run db:migrate` (the compose `migrate` one-shot, or a prod deploy
# step) — the runner reads SQL from `packages/agent-db/drizzle`; drizzle-kit is
# not needed at runtime — and its `src/` so chat-api's `@mymemo/agent-db` imports
# resolve through the workspace symlink in node_modules.
COPY --from=prerelease /usr/src/app/packages/agent-db packages/agent-db
COPY --from=prerelease /usr/src/app/packages/live-text packages/live-text
COPY --from=prerelease /usr/src/app/package.json .

WORKDIR /usr/src/app/apps/chat-api
# Default durable workspace store root (WORKSPACE_STORE_ROOT). Created and owned
# by the `bun` user so the local filesystem adapter can write out of the box;
# mount a persistent volume here in production for durability across recycles.
RUN mkdir -p .workspace-store && chown -R bun:bun .workspace-store
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
