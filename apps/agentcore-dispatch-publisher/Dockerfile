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
RUN cd /temp/prod \
 && bun install --frozen-lockfile --production --filter agentcore-dispatch-publisher

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agentcore-dispatch-publisher apps/agentcore-dispatch-publisher
COPY apps/agentcore-canary-dispatch apps/agentcore-canary-dispatch
COPY packages/agent-db packages/agent-db
COPY package.json ./

WORKDIR /usr/src/app/apps/agentcore-dispatch-publisher
USER bun
ENTRYPOINT ["bun", "run", "src/main.ts"]
