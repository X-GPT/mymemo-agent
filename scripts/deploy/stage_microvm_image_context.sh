#!/usr/bin/env bash
# Assemble the MicroVM image build context (ticket #666, spec #654) into the
# directory given as $1: the infra/microvm-image files plus app/ — the pruned
# Bun workspace the Dockerfile installs with
# `bun install --frozen-lockfile --production --filter in-vm-server`.
#
# One script serves both consumers so the PR-time docker build and the
# registered image are byte-identical contexts:
#   - .github/workflows/microvm-image.yml (PR contract check) builds it;
#   - scripts/deploy/register_microvm_image.sh zips it for
#     create/update-microvm-image.
#
# The workspace prune mirrors apps/agentcore-runtime/Dockerfile's manifests
# stage: every workspace member's package.json (bun.lock refuses to validate
# without the full member set) but sources only for in-vm-server and the
# workspace packages it imports.
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "Usage: scripts/deploy/stage_microvm_image_context.sh <context-dir>" >&2
	exit 2
fi

context="$1"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"

mkdir -p "${context}/app"
cp "${repo_root}/infra/microvm-image/Dockerfile" \
	"${repo_root}/infra/microvm-image/managed-settings.json" \
	"${repo_root}/infra/microvm-image/smoke.sh" \
	"${context}/"

cp "${repo_root}/package.json" "${repo_root}/bun.lock" "${context}/app/"
for manifest in "${repo_root}"/apps/*/package.json "${repo_root}"/packages/*/package.json; do
	member="${manifest#"${repo_root}"/}"
	mkdir -p "${context}/app/$(dirname "${member}")"
	cp "${manifest}" "${context}/app/${member}"
done

# Current AWS RDS global trust bundle, digest-pinned (the same pin as
# apps/agentcore-runtime/Dockerfile) — COPY'd into the image because the
# Lambda image builder's support for ADD --checksum is unverified.
rds_bundle_sha256="e5bb2084ccf45087bda1c9bffdea0eb15ee67f0b91646106e466714f9de3c7e3"
curl -fsSL https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
	-o "${context}/rds-global-bundle.pem"
echo "${rds_bundle_sha256}  ${context}/rds-global-bundle.pem" | shasum -a 256 -c - >/dev/null

cp -R "${repo_root}/apps/in-vm-server/src" "${context}/app/apps/in-vm-server/"
cp -R "${repo_root}/packages/agent-db/src" "${context}/app/packages/agent-db/"
cp -R "${repo_root}/packages/document-tools/src" "${context}/app/packages/document-tools/"
cp -R "${repo_root}/packages/live-text/src" "${context}/app/packages/live-text/"

echo "MicroVM image context staged at ${context}"
