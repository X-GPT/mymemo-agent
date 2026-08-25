# syntax=docker/dockerfile:1.7

ARG BUN_VERSION=1

FROM oven/bun:${BUN_VERSION}-alpine AS base
WORKDIR /usr/src/app

FROM base AS manifests
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

FROM base AS install
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod \
 && bun install --frozen-lockfile --production --filter agent-query-runtime

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agent-query-runtime/src apps/agent-query-runtime/src
COPY apps/agent-query-runtime/package.json apps/agent-query-runtime/
COPY apps/agentcore-runtime/src apps/agentcore-runtime/src
COPY packages/agent-db packages/agent-db
COPY packages/agent-query packages/agent-query
COPY package.json ./
RUN mkdir -p /workspace/conversations && chown -R bun:bun /workspace

WORKDIR /usr/src/app/apps/agent-query-runtime
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
