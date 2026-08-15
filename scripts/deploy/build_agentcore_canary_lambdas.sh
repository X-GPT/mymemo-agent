#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-dist/agentcore-canary-lambdas}"
ca_bundle="${2:-}"

if [[ -z "${ca_bundle}" || ! -f "${ca_bundle}" ]]; then
  echo "Usage: build_agentcore_canary_lambdas.sh <output-dir> <verified-rds-ca-bundle>" >&2
  exit 2
fi

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
build_dir="$(mktemp -d /tmp/mymemo-agentcore-lambdas.XXXXXX)"
trap 'rm -rf "${build_dir}"' EXIT

mkdir -p "${build_dir}/dispatch" "${build_dir}/control"
bun build apps/agentcore-canary-dispatch/src/production.ts \
  --target=node \
  --format=esm \
  --outfile="${build_dir}/dispatch/index.mjs"
bun build apps/agentcore-canary-control/src/lambda.ts \
  --target=node \
  --format=esm \
  --outfile="${build_dir}/control/index.mjs"
cp "${ca_bundle}" "${build_dir}/control/rds-global-bundle.pem"

(
  cd "${build_dir}/dispatch"
  zip -q -X -r "${output_dir}/dispatch.zip" .
)
(
  cd "${build_dir}/control"
  zip -q -X -r "${output_dir}/control.zip" .
)

shasum -a 256 "${output_dir}/dispatch.zip" "${output_dir}/control.zip"
