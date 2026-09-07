# syntax=docker/dockerfile:1.7
FROM oven/bun:1.3.0 AS install
WORKDIR /app
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && bun install --frozen-lockfile --production --filter agent-runtime

FROM oven/bun:1.3.0 AS release
ADD --checksum=sha256:e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
RUN chmod 0444 /etc/ssl/certs/rds-global-bundle.pem
ENV RDS_CA_BUNDLE_PATH=/etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem
WORKDIR /app
COPY --from=install /app/node_modules node_modules
COPY --from=install /app/apps/agent-runtime/node_modules apps/agent-runtime/node_modules
COPY apps/agent-runtime apps/agent-runtime
RUN mkdir -p /opt/mymemo/project && chmod 0555 /opt/mymemo/project
WORKDIR /app/apps/agent-runtime
USER bun
EXPOSE 8080
ENTRYPOINT ["bun", "run", "src/index.ts"]
