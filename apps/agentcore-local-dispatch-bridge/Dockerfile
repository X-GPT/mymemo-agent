FROM oven/bun:1 AS base
WORKDIR /usr/src/app

FROM base AS manifests
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

FROM base AS install
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod && bun install --frozen-lockfile --production --filter=agentcore-local-dispatch-bridge

FROM base AS local
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agentcore-local-dispatch-bridge apps/agentcore-local-dispatch-bridge
COPY apps/agentcore-dispatch-consumer apps/agentcore-dispatch-consumer
COPY packages/agent-db packages/agent-db
COPY packages/agentcore-dispatch packages/agentcore-dispatch
COPY package.json .
WORKDIR /usr/src/app/apps/agentcore-local-dispatch-bridge
USER bun
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
