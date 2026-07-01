#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/deploy/lib/load_config.sh
source "$script_dir/lib/load_config.sh"
load_deploy_config

: "${AGENT_SMOKE_BASE_URL:?AGENT_SMOKE_BASE_URL is required}"

if [[ "$AGENT_SMOKE_BASE_URL" == REPLACE_ME* ]]; then
  echo "AGENT_SMOKE_BASE_URL is required; set it in $config" >&2
  exit 1
fi

bun run scripts/smoke/agent-conversation-smoke.ts
