#!/usr/bin/env bash
# Offline contract check for the MicroVM image skeleton (#661): the assertions
# from the ticket's acceptance criteria that need no live VM. Namespace
# creation (bwrap) cannot run under the CI runner's Docker seccomp/AppArmor —
# that check lives in the in-VM smoke (infra/microvm-image/smoke.sh).
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

# One emulated container run for every in-image assertion. Runs as the image's
# default (non-root) user with networking off.
docker run --rm --platform linux/arm64 --network none --entrypoint bash "$image" -euo pipefail -c '
	[ "$(whoami)" = developer ] || { echo "runtime user is $(whoami), want developer"; exit 1; }

	node --version | grep -q "^v22\." || { echo "node is $(node --version), want v22"; exit 1; }

	sdk="$(NODE_PATH="$(npm root -g)" node -e "console.log(require(\"@anthropic-ai/claude-agent-sdk/package.json\").version)")"
	[ "$sdk" = "0.3.251" ] || { echo "SDK pinned to $sdk, want 0.3.251"; exit 1; }

	cli="$(claude --version | head -1)"
	case "$cli" in 2.1.251*) ;; *) echo "CLI pinned to $cli, want 2.1.251"; exit 1 ;; esac

	command -v bwrap >/dev/null || { echo "bubblewrap missing"; exit 1; }
	command -v socat >/dev/null || { echo "socat missing"; exit 1; }
	command -v git >/dev/null || { echo "git missing"; exit 1; }

	node --check /opt/microvm/server.mjs

	own="$(stat -c "%U:%G %a" /etc/claude-code/managed-settings.json)"
	[ "$own" = "root:root 644" ] || { echo "managed settings are $own, want root:root 644"; exit 1; }
	dirown="$(stat -c "%U:%G %a" /etc/claude-code)"
	[ "$dirown" = "root:root 755" ] || { echo "/etc/claude-code is $dirown, want root:root 755"; exit 1; }
	if echo x > /etc/claude-code/managed-settings.json 2>/dev/null; then
		echo "runtime user overwrote the managed settings"; exit 1
	fi

	echo "microvm image contract holds"
'
