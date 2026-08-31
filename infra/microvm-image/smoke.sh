#!/usr/bin/env bash
# In-VM acceptance checks for the image skeleton (#661), served by GET /smoke.
# One `RESULT <check> <PASS|FAIL> <detail>` line per check; exits non-zero if
# any check failed. Runs as the non-root runtime user.
set -uo pipefail

SDK_VERSION="0.3.251"
CLI_VERSION="2.1.251"
fail=0
r() {
	echo "RESULT $1 $2 ${3:-}"
	if [ "$2" = FAIL ]; then fail=1; fi
}

# bubblewrap namespace smoke — sandbox-mode Bash rides on this. Proven at
# DEFAULT capabilities by the #646 probe; re-proven here on every image.
if bwrap --unshare-all --ro-bind / / --dev /dev true 2>/dev/null; then
	r bwrap PASS "bubblewrap can create namespaces"
else
	r bwrap FAIL "bwrap failed — sandbox-mode Bash unavailable"
fi

# Pinned versions (the spec's exact pins, not ranges).
# Read the manifest with fs — the SDK's exports map refuses
# require("…/package.json").
v=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version)' "$(npm root -g)/@anthropic-ai/claude-agent-sdk/package.json" 2>/dev/null)
if [ "$v" = "$SDK_VERSION" ]; then r sdk-pinned PASS "$v"; else r sdk-pinned FAIL "want $SDK_VERSION got ${v:-none}"; fi
c=$(claude --version 2>/dev/null | head -1)
case "$c" in
"$CLI_VERSION"*) r cli-pinned PASS "$c" ;;
*) r cli-pinned FAIL "want $CLI_VERSION got ${c:-none}" ;;
esac

# Managed settings must be root-owned and non-writable by the runtime user —
# the directory too, or drop-ins merge in.
own=$(stat -c '%U:%G %a' /etc/claude-code/managed-settings.json 2>/dev/null)
if [ "$own" = "root:root 644" ]; then r policy-owner PASS "$own"; else r policy-owner FAIL "${own:-missing}"; fi
if (echo x >/etc/claude-code/managed-settings.json) 2>/dev/null; then
	r policy-immutable FAIL "runtime user overwrote the policy file"
else
	r policy-immutable PASS "policy file not writable by $(whoami)"
fi
if touch /etc/claude-code/drop-in.json 2>/dev/null; then
	rm -f /etc/claude-code/drop-in.json
	r policy-dir FAIL "runtime user can add drop-ins to /etc/claude-code"
else
	r policy-dir PASS "/etc/claude-code not writable by $(whoami)"
fi

if [ "$fail" = 0 ]; then r done PASS "smoke complete"; else r done FAIL "smoke complete"; fi
exit "$fail"
