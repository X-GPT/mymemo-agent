#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
  echo "Usage: scripts/smoke/agentcore-dispatch-publisher-image-check.sh <image>" >&2
  exit 2
fi

docker run --rm \
  --network none \
  --entrypoint bun \
  "$image" \
  --eval 'import { existsSync } from "node:fs"; for (const path of ["/usr/src/app/node_modules/@anthropic-ai", "/usr/src/app/node_modules/e2b", "/usr/src/app/node_modules/@mymemo/live-text"]) { if (existsSync(path)) throw new Error(`worker-only dependency shipped: ${path}`); } await import("./src/config.ts"); await import("./src/publisher-loop.ts"); await import("./src/production.ts"); console.log("AgentCore dispatch publisher image check passed");'
