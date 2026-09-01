#!/usr/bin/env bash
# Offline contract check for the MicroVM image skeleton (#661). The version
# pins, policy-tier ownership, and writability assertions live in the image's
# own /opt/microvm/smoke.sh — run here with SKIP_BWRAP=1 because the CI
# runner's Docker seccomp blocks namespace creation (the real bwrap check runs
# in-VM). Only the CI-specific assertions live inline.
set -euo pipefail

if [[ $# -ne 1 ]]; then
	echo "Usage: scripts/smoke/microvm-image-check.sh <image>" >&2
	exit 2
fi

image="$1"

architecture="$(docker image inspect --format '{{ .Architecture }}' "$image")"
if [[ "$architecture" != "arm64" ]]; then
	echo "MicroVM image architecture must be arm64, got $architecture" >&2
	exit 1
fi

# One emulated container run, as the image's default (non-root) user with
# networking off.
docker run --rm --platform linux/arm64 --network none -e SKIP_BWRAP=1 \
	--entrypoint bash "$image" -euo pipefail -c '
	[ "$(whoami)" = developer ] || { echo "runtime user is $(whoami), want developer"; exit 1; }
	node --version | grep -q "^v22\." || { echo "node is $(node --version), want v22"; exit 1; }
	command -v socat >/dev/null || { echo "socat missing"; exit 1; }
	command -v git >/dev/null || { echo "git missing"; exit 1; }
	node --check /opt/microvm/server.mjs
	bash /opt/microvm/smoke.sh
'

echo "microvm image contract holds"
