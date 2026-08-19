#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-dist/agentcore-consumer}"
ca_bundle="${2:-}"

if [[ -z "${ca_bundle}" || ! -f "${ca_bundle}" ]]; then
  echo "Usage: build_agentcore_consumer.sh <output-dir> <verified-rds-ca-bundle>" >&2
  exit 2
fi

mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
build_dir="$(mktemp -d /tmp/mymemo-agentcore-lambdas.XXXXXX)"
trap 'rm -rf "${build_dir}"' EXIT

mkdir -p "${build_dir}/dispatch"
bun build apps/agentcore-canary-dispatch/src/production.ts \
  --target=node \
  --format=esm \
  --outfile="${build_dir}/dispatch/index.mjs"
cp "${ca_bundle}" "${build_dir}/dispatch/rds-global-bundle.pem"

(
  cd "${build_dir}/dispatch"
  zip -q -X -r "${output_dir}/consumer.zip" .
)
shasum -a 256 "${output_dir}/consumer.zip"
