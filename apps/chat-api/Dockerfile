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

COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Copy source, prebuild daemon bundle, and run tests
FROM base AS prerelease
COPY --from=install /temp/dev/node_modules node_modules
COPY apps/chat-api/ apps/chat-api/
COPY apps/sandbox-daemon/ apps/sandbox-daemon/
COPY packages/llm-token/ packages/llm-token/
COPY package.json .

WORKDIR /usr/src/app/apps/chat-api
ENV NODE_ENV=production
RUN bun run build:daemon
RUN bun test

# Final release image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/apps/chat-api/src apps/chat-api/src
COPY --from=prerelease /usr/src/app/apps/chat-api/package.json apps/chat-api/
COPY --from=prerelease /usr/src/app/apps/chat-api/tsconfig.json apps/chat-api/
COPY --from=prerelease /usr/src/app/apps/sandbox-daemon/dist apps/sandbox-daemon/dist
COPY --from=prerelease /usr/src/app/packages/llm-token packages/llm-token
COPY --from=prerelease /usr/src/app/package.json .

WORKDIR /usr/src/app/apps/chat-api
# Default durable workspace store root (WORKSPACE_STORE_ROOT). Created and owned
# by the `bun` user so the local filesystem adapter can write out of the box;
# mount a persistent volume here in production for durability across recycles.
RUN mkdir -p .workspace-store && chown -R bun:bun .workspace-store
USER bun
EXPOSE 3000/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
