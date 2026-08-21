#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/smoke/agent-worker-image-check.sh <agent-worker-image>" >&2
  exit 2
fi

image="$1"

runtime_aware="$(
  docker image inspect \
    --format '{{ index .Config.Labels "com.mymemo.agent-worker.execution-runtime-aware" }}' \
    "$image"
)"
if [[ "$runtime_aware" != "true" ]]; then
  echo "Agent-worker image is missing its execution-runtime-aware capability label" >&2
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
  --eval 'import { existsSync } from "node:fs"; import { resolveAndVerifyClaudeCodeExecutable } from "./src/sdk/claude-code-executable.ts"; for (const path of ["/usr/src/app/node_modules/@aws-sdk/client-sqs", "/usr/src/app/node_modules/@aws-sdk/client-ssm", "/usr/src/app/node_modules/@mymemo/agentcore-dispatch", "/usr/src/app/node_modules/agentcore-dispatch-publisher"]) { if (existsSync(path)) throw new Error(`publisher-only dependency shipped: ${path}`); } const executable = resolveAndVerifyClaudeCodeExecutable(); console.log(`agent-worker image check passed: ${executable}`);'
