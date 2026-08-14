#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/smoke/agent-worker-image-check.sh <agent-worker-image>" >&2
  exit 2
fi

image="$1"

lane_aware="$(
  docker image inspect \
    --format '{{ index .Config.Labels "com.mymemo.agent-worker.execution-lane-aware" }}' \
    "$image"
)"
if [[ "$lane_aware" != "true" ]]; then
  echo "Agent-worker image is missing its execution-lane-aware capability label" >&2
  exit 1
fi

# Override the worker entrypoint so this remains credential-free: importing the
# production boot helper resolves the SDK-owned glibc binary from the final
# image's pruned node_modules and exec-verifies it with `--version`.
docker run --rm \
  --platform linux/amd64 \
  --network none \
  --entrypoint bun \
  "$image" \
  --eval 'import { resolveAndVerifyClaudeCodeExecutable } from "./src/sdk/claude-code-executable.ts"; const executable = resolveAndVerifyClaudeCodeExecutable(); console.log(`agent-worker image check passed: ${executable}`);'
