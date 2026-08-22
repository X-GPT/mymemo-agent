#!/usr/bin/env bash
set -euo pipefail

image="${1:-}"
if [[ -z "$image" ]]; then
  echo "Usage: scripts/smoke/agent-maintenance-image-check.sh <agent-maintenance-image>" >&2
  exit 2
fi

docker run --rm --entrypoint bun "$image" --eval '
import { existsSync } from "node:fs";
import { loadMaintenanceConfigFromEnv } from "./src/config.ts";

for (const path of [
  "/usr/src/app/apps/agent-worker/src/run-loop.ts",
  "/usr/src/app/apps/agent-worker/src/run-serving.ts",
  "/usr/src/app/apps/agent-worker/src/model-client.ts",
  "/usr/src/app/apps/agent-worker/src/production-run-resources.ts",
]) {
  if (existsSync(path)) throw new Error(`Run-serving source shipped: ${path}`);
}

loadMaintenanceConfigFromEnv({
  AGENT_DATABASE_URL: "postgresql://agent@db.example.com:5432/mymemo_agent",
  E2B_API_KEY: "image-check",
  ARTIFACT_BUCKET: "image-check",
  AWS_REGION: "us-west-2",
});
console.log("agent-maintenance image check passed");
'
