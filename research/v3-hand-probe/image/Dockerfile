# PROBE IMAGE — throwaway (wayfinder #708). The v3 "hand": a bare tool server, no SDK, no
# credentials, no managed-settings. Everything the model can run lives behind /bash etc.
FROM public.ecr.aws/lambda/microvms:al2023-minimal
RUN dnf install -y bash coreutils findutils grep gzip nodejs22 nodejs22-npm shadow-utils tar util-linux \
 && dnf clean all
RUN npm install -g bun@1.3.0
RUN useradd -m -u 1000 developer && mkdir -p /opt/hand
COPY --chown=root:root --chmod=0644 hand.ts /opt/hand/hand.ts
COPY --chown=developer:developer workspace /home/developer/workspace
ENV WORKSPACE_DIR=/home/developer/workspace
ENV HAND_PORT=8080
USER developer
WORKDIR /home/developer/workspace
ENTRYPOINT ["bun", "run", "/opt/hand/hand.ts"]
