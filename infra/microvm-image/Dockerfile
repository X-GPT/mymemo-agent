# Production MicroVM image for the per-Conversation VM (ticket #661, spec #654).
# Derived from the #646 probe kit (docs/research/microvm-probe on the
# research/microvm-probe branch), which proved this recipe live: AL2023 base at
# DEFAULT capabilities — bubblewrap creates namespaces with no ALL flag.
# server.mjs is a placeholder; #666 swaps in the real In-VM server.
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# bubblewrap backs sandbox-mode Bash; socat relays the egress proxy; nodejs22
# runs the SDK; shadow-utils provides useradd. dnf installs are all-or-nothing:
# one unavailable package fails the whole line (ripgrep is absent from AL2023
# repos and must stay off this list — Claude Code ships its own rg).
RUN dnf install -y bash git nodejs22 nodejs22-npm shadow-utils bubblewrap socat util-linux \
 && dnf clean all

# The versions the spec pins. The runtime resolves the global SDK install via
# NODE_PATH="$(npm root -g)".
RUN npm install -g @anthropic-ai/claude-agent-sdk@0.3.251 @anthropic-ai/claude-code@2.1.251

# Managed policy tier: root-owned so the non-root runtime user can neither
# replace it nor merge drop-ins in (the directory matters as much as the file).
# Deny rules use Edit(...) — Write(...) entries are inert (the CLI warns they
# are "not matched by file permission checks — only Edit").
RUN mkdir -p /etc/claude-code && chown root:root /etc/claude-code && chmod 0755 /etc/claude-code
COPY --chown=root:root --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json

# Non-root runtime user: the policy tier's protection assumes the agent cannot
# write /etc.
RUN useradd -m -u 1000 developer
COPY --chown=root:root --chmod=0755 server.mjs /opt/microvm/server.mjs
COPY --chown=root:root --chmod=0755 smoke.sh /opt/microvm/smoke.sh

ENV CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
EXPOSE 8080
USER developer
WORKDIR /home/developer/workspace
ENTRYPOINT ["node", "/opt/microvm/server.mjs"]
