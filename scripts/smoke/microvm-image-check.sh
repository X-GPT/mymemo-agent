#!/usr/bin/env bash
# Offline contract check for the production MicroVM image (#661/#666). The
# version pins, policy-tier ownership, and writability assertions live in the
# image's own /opt/microvm/smoke.sh — run here with SKIP_BWRAP=1 because the
# CI runner's Docker seccomp blocks namespace creation (the real bwrap check
# runs in-VM). The boot check proves the baked In-VM server actually starts
# unconfigured and answers the image-build /ready hook — the exact state
# create-microvm-image snapshots — so a broken install fails the PR, not the
# registration.
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
	bash /opt/microvm/smoke.sh

	# Boot the entrypoint unconfigured and probe the image-build contract:
	# /ready 200 (gates the snapshot), /health 200, /nudge 503 (no
	# Conversation until the /run hook delivers runHookPayload).
	bun run /opt/microvm/app/apps/in-vm-server/src/index.ts &
	server=$!
	probe() { bun -e "const r = await fetch(\"http://127.0.0.1:8080$1\", {method: \"$2\"}); process.exit(r.status === $3 ? 0 : 1)" 2>/dev/null; }
	up=0
	for _ in $(seq 1 60); do
		if probe /health GET 200; then up=1; break; fi
		kill -0 "$server" 2>/dev/null || { echo "server exited during boot"; exit 1; }
		sleep 2
	done
	[ "$up" = 1 ] || { echo "server never answered /health"; exit 1; }
	probe /aws/lambda-microvms/runtime/v1/ready POST 200 || { echo "/ready hook did not answer 200"; exit 1; }
	probe /nudge POST 503 || { echo "unconfigured /nudge should answer 503"; exit 1; }
	kill "$server"
	echo "in-vm server boots unconfigured and answers the build hooks"
'

echo "microvm image contract holds"
