# syntax=docker/dockerfile:1.7

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
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS release
LABEL com.mymemo.agentcore-runtime.request-oriented="true"
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/agentcore-canary-runtime apps/agentcore-canary-runtime
COPY apps/agentcore-canary-dispatch apps/agentcore-canary-dispatch
COPY apps/agent-worker apps/agent-worker
COPY packages/agent-db packages/agent-db
COPY packages/live-text packages/live-text
COPY package.json .

# Current AWS RDS global trust bundle, digest-pinned at image build. Both agent
# and KB PostgreSQL URLs are separately required to use sslmode=verify-full.
ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV RDS_CA_BUNDLE_PATH=/etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

RUN chmod 0444 /etc/ssl/certs/rds-global-bundle.pem \
 && mkdir -p /workspace/conversations \
 && chown -R bun:bun /workspace

WORKDIR /usr/src/app/apps/agentcore-canary-runtime
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
