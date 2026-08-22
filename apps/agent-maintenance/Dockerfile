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
 && bun install --frozen-lockfile --production --filter agent-maintenance

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agent-maintenance apps/agent-maintenance
COPY apps/agent-worker/package.json apps/agent-worker/
COPY apps/agent-worker/src/maintenance-runner.ts apps/agent-worker/src/logger.ts apps/agent-worker/src/
COPY apps/agent-worker/src/cleanup/advisory-lock.ts apps/agent-worker/src/cleanup/cleanup.ts apps/agent-worker/src/cleanup/e2b-janitor.ts apps/agent-worker/src/cleanup/s3-artifact-janitor.ts apps/agent-worker/src/cleanup/
COPY packages/agent-db packages/agent-db
COPY package.json ./

WORKDIR /usr/src/app/apps/agent-maintenance
USER bun
EXPOSE 8080/tcp
ENTRYPOINT ["bun", "run", "src/main.ts"]
