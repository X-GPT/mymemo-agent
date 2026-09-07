#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-dist/agent-front}"
mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
build_dir="$(mktemp -d /tmp/mymemo-front.XXXXXX)"
trap 'rm -rf "${build_dir}"' EXIT

# Bundle the JS loader but leave its native Linux ARM64 module alongside it.
bun build apps/agent-front/src/lambda.ts --target=node --format=esm \
  --external='@statsig/statsig-node-core-linux-*' \
  --external='@statsig/statsig-node-core-darwin-*' \
  --external='@statsig/statsig-node-core-win32-*' \
  --outfile="${build_dir}/index.mjs"
version="$(bun -e 'console.log(require("./apps/agent-front/node_modules/@statsig/statsig-node-core/package.json").version)')"
printf '{"dependencies":{"@statsig/statsig-node-core-linux-arm64-gnu":"%s"}}\n' "${version}" > "${build_dir}/package.json"
bun install --cwd "${build_dir}" --os=linux --cpu=arm64 --production
# Verify the native payload is present; never ship the laptop's Darwin binary.
test -f "${build_dir}/node_modules/@statsig/statsig-node-core-linux-arm64-gnu/statsig-node-core.linux-arm64-gnu.node"
rm -f "${output_dir}/front.zip"
(cd "${build_dir}" && zip -q -X -r "${output_dir}/front.zip" index.mjs node_modules)
shasum -a 256 "${output_dir}/front.zip"
