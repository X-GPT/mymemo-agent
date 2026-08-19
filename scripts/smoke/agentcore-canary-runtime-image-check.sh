#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "Usage: scripts/smoke/agentcore-canary-runtime-image-check.sh <image>" >&2
  exit 2
fi

image="$1"

architecture="$(docker image inspect --format '{{ .Architecture }}' "$image")"
if [[ "$architecture" != "arm64" ]]; then
  echo "AgentCore Runtime image architecture must be arm64, got $architecture" >&2
  exit 1
fi

request_oriented="$(
  docker image inspect \
    --format '{{ index .Config.Labels "com.mymemo.agentcore-runtime.request-oriented" }}' \
    "$image"
)"
if [[ "$request_oriented" != "true" ]]; then
  echo "AgentCore Runtime image is missing its request-oriented label" >&2
  exit 1
fi

ambient_env="$(docker image inspect --format '{{ range .Config.Env }}{{ println . }}{{ end }}' "$image")"
if grep -Eq '^(AGENT_DATABASE_URL|KB_DATABASE_URL|OPENROUTER_API_KEY|E2B_API_KEY|REDIS_URL)=' <<<"$ambient_env"; then
  echo "AgentCore Runtime image contains an ambient secret value variable" >&2
  exit 1
fi

# Verify the pinned SDK-owned ARM64 CLI and the baked CA with all networking
# disabled. Execute the same --version boot check used in production. Old x64
# Docker/QEMU combinations can SIGSEGV a valid ARM64 binary; only on that
# identifiable host-emulation path, fall back to checking the resolved ELF.
docker run --rm \
  --platform linux/arm64 \
  --network none \
  --entrypoint bun \
  "$image" \
  run src/image-cli-contract.ts

# Exercise successful /ping and /invocations NDJSON contracts inside the built
# image. This uses the server boundary's stubbed execution dependency, so the
# check remains offline and does not need production secrets.
docker run --rm \
  --platform linux/arm64 \
  --network none \
  --entrypoint bun \
  "$image" \
  test src/server.test.ts

# The real entrypoint must fail closed before serving /ping when fresh-session
# bootstrap is incomplete. Omit one secret ARN and assert the named boot error;
# this exercises production startup without making a network request.
if entrypoint_output="$(
  docker run --rm \
    --platform linux/arm64 \
    --network none \
    -e AWS_REGION=us-west-2 \
    -e AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME=/mymemo/agentcore-dispatch/prod/enabled \
    -e AGENT_DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf \
    -e KB_DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf \
    -e OPENROUTER_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:openrouter-AbCdEf \
    -e E2B_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:e2b-AbCdEf \
    -e OPENROUTER_BASE_URL=https://openrouter.ai/api \
    -e OPENROUTER_DEFAULT_MODEL=anthropic/claude-sonnet-4 \
    -e WORKER_E2B_TEMPLATE=mymemo-agent-sandbox \
    -e ARTIFACT_BUCKET=private-artifacts \
    "$image" 2>&1
)"; then
  echo "AgentCore Runtime entrypoint accepted incomplete bootstrap" >&2
  exit 1
fi
if ! grep -q 'REDIS_URL_SECRET_ARN is required' <<<"$entrypoint_output"; then
  echo "$entrypoint_output" >&2
  echo "AgentCore Runtime entrypoint did not report its fail-closed boot error" >&2
  exit 1
fi
