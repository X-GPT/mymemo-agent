FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# Prune the context to just the workspace manifests. The root lockfile describes
# every workspace member, so --frozen-lockfile needs each member's package.json
# present (only package.json — no source). Deriving the set this way means a new
# workspace member needs no Dockerfile edit, and the install layer still caches
# on manifest content alone.
FROM base AS manifests
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN find apps packages -type f ! -name package.json -delete \
 && find apps packages -type d -empty -delete

# Install dependencies from the pruned manifests.
FROM base AS install
COPY --from=manifests /usr/src/app /temp/prod
RUN cd /temp/prod && bun install --frozen-lockfile --production

# Final release image
FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY apps/gateway/src apps/gateway/src
COPY apps/gateway/package.json apps/gateway/tsconfig.json apps/gateway/
COPY packages/llm-token packages/llm-token
COPY package.json .

WORKDIR /usr/src/app/apps/gateway
USER bun
EXPOSE 8080/tcp
ENTRYPOINT [ "bun", "run", "src/index.ts" ]
