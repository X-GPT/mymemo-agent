# Local E2E sandbox image: replaces the E2B sandbox with a long-lived container
# that runs the same daemon + agent bundles. Mirrors the E2B template
# (apps/chat-api/sandbox-template/template.ts) — Node 24 base, bun, the
# `mymemo-docs` CLI on PATH, the `claude` binary — but BAKES the bundles in
# instead of having chat-api push them per turn (the local provider only
# health-checks; see apps/chat-api/src/features/sandbox-orchestration/
# local-container-sandbox-provider.ts).
#
# Build context is the repo root (see compose.yaml).

# --- builder: install workspace deps and bundle daemon.js, agent.js, the CLI ---
FROM oven/bun:1 AS builder
WORKDIR /src
COPY package.json bun.lock ./
COPY apps apps
COPY packages packages
RUN bun install --frozen-lockfile
# bun build --target=bun bundles each entry with its deps (the Claude Agent SDK
# is inlined into agent.js), so the runtime image needs no node_modules.
RUN cd apps/sandbox-daemon && bun run build
RUN cd apps/mymemo-docs && bun run build

# --- runtime: Node 24 + bun + the claude binary, bundles baked in ---
FROM node:24-bookworm-slim AS runtime

# Same apt surface as the E2B template, minus bubblewrap: the agent now runs
# directly (the container is the isolation boundary). curl installs bun;
# ca-certificates is needed for TLS to the gateway.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git ripgrep lsof zstd unzip \
 && rm -rf /var/lib/apt/lists/*

# bun runs the daemon and the per-turn agent bundle.
RUN curl -fsSL https://bun.sh/install | bash \
 && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# The `claude` binary the Agent SDK spawns (the agent sets
# CLAUDE_CODE_PATH=/usr/local/bin/claude; npm's global bin is /usr/local/bin).
# Pinned + overridable: keep roughly in step with @anthropic-ai/claude-agent-sdk
# (bundled into agent.js) — version drift here is MYM-31 open question #3.
ARG CLAUDE_CODE_VERSION=2.1.181
RUN npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}

WORKDIR /workspace
RUN mkdir -p /workspace/data

# The agent's document-access CLI on PATH (holds no credential — it forwards to
# the gateway with the per-turn MYMEMO_DOC_* env the daemon sets).
COPY --from=builder /src/apps/mymemo-docs/dist/mymemo-docs /usr/local/bin/mymemo-docs
RUN chmod 0755 /usr/local/bin/mymemo-docs

# Bake the daemon + agent bundles where they are expected (/workspace/{daemon,
# agent}.js). Unlike E2B, chat-api does NOT push bundles to this provider.
COPY --from=builder /src/apps/sandbox-daemon/dist/daemon.js /workspace/daemon.js
COPY --from=builder /src/apps/sandbox-daemon/dist/agent.js /workspace/agent.js

# DAEMON_AUTH_TOKEN + AGENT_SESSION_STORE_ROOT are supplied at runtime (compose).
ENV DAEMON_PORT=8080 \
    DAEMON_VERSION=local
EXPOSE 8080/tcp
CMD ["bun", "/workspace/daemon.js"]
