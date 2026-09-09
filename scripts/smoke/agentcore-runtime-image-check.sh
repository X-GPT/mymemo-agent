#!/usr/bin/env bash
set -euo pipefail
image="${1:?Usage: agentcore-runtime-image-check.sh <agent-runtime-image>}"
[[ "$(docker image inspect --format '{{ .Architecture }}' "$image")" == arm64 ]]
docker run --rm --platform linux/arm64 --network none --entrypoint bun "$image" \
  test --timeout=60000 src/runtime.test.ts src/config.test.ts
