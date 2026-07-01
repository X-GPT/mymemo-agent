#!/usr/bin/env bash
set -euo pipefail

config="${DEPLOY_CONFIG:-infra/deploy/prod.env}"
if [[ -f "$config" ]]; then
  # shellcheck disable=SC1090
  source "$config"
fi

: "${AGENT_SMOKE_BASE_URL:?AGENT_SMOKE_BASE_URL is required}"

if [[ "$AGENT_SMOKE_BASE_URL" == REPLACE_ME* ]]; then
  echo "AGENT_SMOKE_BASE_URL is required; set it in $config" >&2
  exit 1
fi

bun run scripts/smoke/agent-conversation-smoke.ts
