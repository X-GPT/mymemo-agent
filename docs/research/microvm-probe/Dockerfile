# Probe image for ticket #646. Confinement bundle from the SDK-confinement research
# note (research/agent-sdk-confinement), packaging from the AWS Claude Code sample.
# Built TWICE by orchestrate: once WITHOUT and once WITH --additional-os-capabilities
# ["ALL"] — the difference is the whole point of item 2 (does bwrap need ALL caps?).
FROM public.ecr.aws/lambda/microvms:al2023-minimal

# bubblewrap = sandbox-mode Bash's filesystem isolation; socat = proxy relay;
# nodejs22 runs the SDK; shadow-utils provides useradd; iproute/bind-utils/nc for egress.
# (ripgrep dropped: not in AL2023 repos — it fails the whole dnf line; Claude Code ships its own rg.)
RUN dnf install -y bash git nodejs22 nodejs22-npm python3.12 shadow-utils \
      bubblewrap socat iproute bind-utils nmap-ncat util-linux \
 && dnf clean all

# Pin the SDK version the map chose.
RUN npm install -g @anthropic-ai/claude-agent-sdk@0.3.251 @anthropic-ai/claude-code@2.1.251

# Managed policy tier: root-owned so the non-root agent cannot replace it (moots #634's
# timing race). The directory must not be agent-writable — drop-ins merge in.
RUN mkdir -p /etc/claude-code && chown root:root /etc/claude-code && chmod 0755 /etc/claude-code
COPY --chown=root:root --chmod=0644 managed-settings.json /etc/claude-code/managed-settings.json

# Non-root agent, matching the intended production posture (the AWS sample runs as root;
# we deliberately don't — the policy tier's protection assumes the agent can't write /etc).
RUN useradd -m -u 1000 developer
COPY --chown=root:root --chmod=0755 probe-server.mjs /opt/probe/probe-server.mjs
COPY --chown=root:root --chmod=0755 probe.sh /opt/probe/probe.sh

ENV CLAUDE_CODE_DISABLE_AUTO_MEMORY=1
EXPOSE 8080
USER developer
WORKDIR /home/developer/workspace
ENTRYPOINT ["node", "/opt/probe/probe-server.mjs"]
