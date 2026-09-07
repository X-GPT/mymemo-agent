#!/usr/bin/env bash
set -euo pipefail

output_dir="${1:-dist/agent-front}"
mkdir -p "${output_dir}"
output_dir="$(cd "${output_dir}" && pwd)"
build_dir="$(mktemp -d /tmp/mymemo-front.XXXXXX)"
trap 'rm -rf "${build_dir}"' EXIT

# Keep native loaders external: bundling Statsig embeds the build host's
# __filename in createRequire, which cannot resolve modules inside Lambda.
# Install only the front's production closure from the repository lockfile.
for manifest in package.json apps/*/package.json packages/*/package.json; do
  mkdir -p "${build_dir}/$(dirname "${manifest}")"
  cp "${manifest}" "${build_dir}/${manifest}"
done
cp bun.lock "${build_dir}/bun.lock"
bun install --cwd "${build_dir}" --frozen-lockfile --production \
  --filter agent-front --linker=hoisted --os=linux --cpu=arm64
bun build apps/agent-front/src/lambda.ts --target=node --format=esm \
  --external '@aws-sdk/*' --external '@statsig/*' --outfile="${build_dir}/index.mjs"
test -f "${build_dir}/node_modules/@statsig/statsig-node-core-linux-arm64-gnu/statsig-node-core.linux-arm64-gnu.node"
rm -f "${output_dir}/front.zip"
(cd "${build_dir}" && zip -q -X -r "${output_dir}/front.zip" index.mjs node_modules)
shasum -a 256 "${output_dir}/front.zip"
