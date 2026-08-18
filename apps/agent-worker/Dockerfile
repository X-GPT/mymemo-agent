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
# runtime artifact. Filter the install to the worker's transitive workspace
# graph so publisher-only dependencies never enter this image.
FROM base AS install
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod \
 && bun install --frozen-lockfile --production --filter agent-worker

# Final release image.
FROM base AS release
LABEL com.mymemo.agent-worker.execution-runtime-aware="true"
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agent-worker/src apps/agent-worker/src
COPY apps/agent-worker/package.json apps/agent-worker/tsconfig.json apps/agent-worker/
# The shared writable-DB data layer (schema, client, run-store helpers). Its src
# must be present so the worker's `@mymemo/agent-db` imports resolve through the
# workspace symlink in node_modules.
COPY packages/agent-db packages/agent-db
COPY packages/live-text packages/live-text
COPY package.json .

# The SDK cwd is a Fargate-side, per-conversation session anchor. Prepare the
# conversations root while privileged; each query creates its own child.
RUN mkdir -p /workspace/conversations \
 && chown -R bun:bun /workspace

WORKDIR /usr/src/app/apps/agent-worker
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
