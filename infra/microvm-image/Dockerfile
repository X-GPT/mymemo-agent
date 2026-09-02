# Production MicroVM image for the per-Conversation VM (spec #654). #661
# proved the platform recipe with a placeholder server; #666 bakes the real
# In-VM server (apps/in-vm-server) as the entrypoint. Derived from the #646
# probe kit (docs/research/microvm-probe on the research/microvm-probe branch).
#
# Build context: assembled by scripts/deploy/stage_microvm_image_context.sh —
# this file plus app/ (the pruned Bun workspace). The image boots the server
# unconfigured (the build's /ready hook needs no Conversation); per-VM
# configuration arrives at run time via the /run hook's runHookPayload.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# No bubblewrap or socat: they exist only to sandbox shell commands, and there
# is no shell — the Bash tool is denied (ADR-0034 amendment).
# nodejs22 runs the smoke checks; shadow-utils provides useradd; tar + gzip
# pack and unpack the Checkpoint (#670). dnf installs are all-or-nothing: one
# unavailable package fails the whole line (ripgrep is absent from AL2023
# repos anyway — Claude Code ships its own rg).
RUN dnf install -y bash git gzip nodejs22 nodejs22-npm shadow-utils tar util-linux \
 && dnf clean all

# Bun runs the In-VM server (the CI-pinned version). The Claude Agent SDK and
# its native CLI binary install below via bun install — the workspace pins
# SDK 0.3.251, whose linux-arm64 optional dependency is CLI 2.1.251.
RUN npm install -g bun@1.3.0

# Create the COPY target directories explicitly: newer BuildKit applies
# --chmod to parent directories it creates, which would leave them 0644 —
# untraversable by the non-root user.
RUN mkdir -p /etc/claude-code /opt/microvm

# Managed policy tier: root-owned so the non-root runtime user can neither
# replace it nor merge drop-ins in (the directory matters as much as the
# file). Deny rules use Edit(...) — Write(...) entries are inert (the CLI
# warns they are "not matched by file permission checks — only Edit").
COPY --chown=root:root --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json

# Non-root runtime user: the policy tier's protection assumes the agent cannot
# write /etc. The Workspace is the one directory the agent owns — created
# explicitly so no root-owned WORKDIR shadows it.
RUN useradd -m -u 1000 developer \
 && mkdir -p /home/developer/workspace \
 && chown developer:developer /home/developer/workspace

# The In-VM server: pruned workspace, production install for exactly the
# in-vm-server workspace. Root-owned — the runtime user reads, never writes.
COPY app /opt/microvm/app
RUN cd /opt/microvm/app \
 && bun install --frozen-lockfile --production --filter in-vm-server

COPY --chown=root:root --chmod=0644 smoke.sh /opt/microvm/smoke.sh

# Current AWS RDS global trust bundle — the trusted process verifies the
# agent Postgres over TLS (Bun honours NODE_EXTRA_CA_CERTS). Fetched
# digest-pinned by the staging script rather than ADD --checksum: the Lambda
# image builder's BuildKit frontend support is unverified.
COPY --chown=root:root --chmod=0444 rds-global-bundle.pem /etc/ssl/certs/rds-global-bundle.pem
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/rds-global-bundle.pem

# Image-level environment is shared by every VM (per-VM values ride
# runHookPayload). The CLI env allowlist keeps all of it away from the spawned
# CLI except what query-options.ts sets deliberately.
ENV CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
ENV WORKSPACE_DIR=/home/developer/workspace
ENV SMOKE_SCRIPT=/opt/microvm/smoke.sh

USER developer
WORKDIR /home/developer/workspace
ENTRYPOINT ["bun", "run", "/opt/microvm/app/apps/in-vm-server/src/index.ts"]
