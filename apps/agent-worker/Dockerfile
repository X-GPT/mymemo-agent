FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Prune the context to just the workspace manifests. --frozen-lockfile needs
# every member's package.json (the root lockfile describes them all), and
# deriving the set this way means a new workspace member needs no Dockerfile
# edit. Only package.json files plus the root lockfile survive, so the install
# layer below still caches on manifest content alone.
FROM base AS manifests
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

# Install production dependencies only. The worker runs `src/index.ts` directly
# (no build step), so it needs no dev dependencies. Tests are NOT run here —
# CI (.github/workflows/ci.yml) is the test gate; the image just builds the
# runtime artifact.
FROM base AS install
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Final release image.
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agent-worker/src apps/agent-worker/src
COPY apps/agent-worker/package.json apps/agent-worker/tsconfig.json apps/agent-worker/
COPY package.json .

WORKDIR /usr/src/app/apps/agent-worker
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
