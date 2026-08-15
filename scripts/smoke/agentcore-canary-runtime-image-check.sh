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
  --eval 'const ca = Bun.file(process.env.RDS_CA_BUNDLE_PATH); if (!(await ca.exists()) || ca.size < 100000) throw new Error("RDS CA bundle missing"); const { readFileSync } = await import("node:fs"); const { resolveAndVerifyClaudeCodeExecutable } = await import("../agent-worker/src/sdk/claude-code-executable.ts"); try { console.log(resolveAndVerifyClaudeCodeExecutable()); } catch (error) { const cause = error instanceof Error && error.cause && typeof error.cause === "object" ? error.cause : undefined; const signal = cause && "signal" in cause ? cause.signal : undefined; const cpuInfo = readFileSync("/proc/cpuinfo", "utf8"); if (signal !== "SIGSEGV" || !/vendor_id\s*:\s*(?:GenuineIntel|AuthenticAMD)/.test(cpuInfo)) throw error; const executable = resolveAndVerifyClaudeCodeExecutable({ execFile(path, args) { const elf = readFileSync(path); if (args[0] !== "--version") throw new Error("CLI verification contract changed"); if (elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46 || (elf[18] | (elf[19] << 8)) !== 183) throw new Error("resolved Claude CLI is not AArch64 ELF"); } }); console.warn("ARM64 CLI execution unavailable after SIGSEGV under x64 host emulation; verified executable contract and ELF instead"); console.log(executable); }'

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
    -e CANARY_ENABLED_PARAMETER_NAME=/mymemo/canary/enabled \
    -e CANARY_AGENT_DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf \
    -e CANARY_KB_DATABASE_URL_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf \
    -e CANARY_OPENROUTER_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:openrouter-AbCdEf \
    -e CANARY_E2B_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-west-2:123456789012:secret:e2b-AbCdEf \
    -e OPENROUTER_BASE_URL=https://openrouter.ai/api \
    -e OPENROUTER_DEFAULT_MODEL=anthropic/claude-sonnet-4 \
    -e WORKER_E2B_TEMPLATE=mymemo-agent-sandbox \
    -e ARTIFACT_BUCKET=private-artifacts \
    "$image" 2>&1
)"; then
  echo "AgentCore Runtime entrypoint accepted incomplete bootstrap" >&2
  exit 1
fi
if ! grep -q 'CANARY_REDIS_URL_SECRET_ARN is required' <<<"$entrypoint_output"; then
  echo "$entrypoint_output" >&2
  echo "AgentCore Runtime entrypoint did not report its fail-closed boot error" >&2
  exit 1
fi
