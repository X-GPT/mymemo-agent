#!/usr/bin/env bash
# In-VM acceptance checks for the production image (#661/#666). One
# `RESULT <check> <PASS|FAIL> <detail>` line per check; exits non-zero if any
# check failed. Runs as the non-root runtime user.
#
# The version pins attest the copy that actually serves: the workspace install
# under /opt/microvm/app (the spec pins SDK 0.3.251; its linux-arm64 optional
# dependency is the CLI binary, versioned 2.1.251 by the SDK's manifest).
set -uo pipefail

SDK_VERSION="0.3.251"
CLI_VERSION="2.1.251"
APP=/opt/microvm/app
SDK_DIR="$APP/apps/in-vm-server/node_modules/@anthropic-ai/claude-agent-sdk"
fail=0
r() {
	echo "RESULT $1 $2 ${3:-}"
	if [ "$2" = FAIL ]; then fail=1; fi
}

# bubblewrap smoke — sandbox-mode Bash rides on this. Two checks, because
# namespace creation alone is NOT the bar: Claude Code's sandbox also mounts a
# fresh /proc, and mounting procfs inside a user namespace is refused
# ("Operation not permitted") whenever the host's /proc is not "fully visible"
# — the masked-/proc rule that also bites unprivileged containers.
#
# Live on #666: the namespace-only check below PASSED on a real VM while every
# Bash tool call failed with `bwrap: Can't mount proc on /newroot/proc`. The
# #646 probe carried the same gap, which is how the spec came to record
# "bwrap works at default caps". Never drop the proc check — it is the one
# that speaks for the tool the agent actually runs.
#
# SKIP_BWRAP=1: CI runs this in a Docker container whose seccomp blocks
# namespace creation — presence is still checkable, the real checks run in-VM.
if [ "${SKIP_BWRAP:-0}" = 1 ]; then
	if command -v bwrap >/dev/null; then r bwrap-present PASS; else r bwrap-present FAIL "bubblewrap missing"; fi
else
	if bwrap --unshare-all --ro-bind / / --dev /dev true 2>/dev/null; then
		r bwrap-namespaces PASS "bubblewrap can create namespaces"
	else
		r bwrap-namespaces FAIL "bwrap cannot create namespaces"
	fi
	# The decisive check: the same shape Claude Code's Bash sandbox uses.
	if err=$(bwrap --unshare-all --ro-bind / / --proc /proc --dev /dev true 2>&1); then
		r bwrap-proc PASS "bubblewrap can mount /proc — sandbox-mode Bash usable"
	else
		r bwrap-proc FAIL "sandbox-mode Bash unusable: ${err}"
	fi
fi

# Pinned versions (the spec's exact pins, not ranges) on the serving install.
v=$(node -p 'require(process.argv[1]).version' "$SDK_DIR/package.json" 2>/dev/null)
if [ "$v" = "$SDK_VERSION" ]; then r sdk-pinned PASS "$v"; else r sdk-pinned FAIL "want $SDK_VERSION got ${v:-none}"; fi
c=$(node -p 'require(process.argv[1]).version' "$SDK_DIR/manifest.json" 2>/dev/null)
if [ "$c" = "$CLI_VERSION" ]; then r cli-pinned PASS "$c"; else r cli-pinned FAIL "want $CLI_VERSION got ${c:-none}"; fi

# The native CLI binary the server resolves (claude-code-executable.ts): the
# glibc linux-arm64 optional dependency must be present and executable. Exec
# verification happens in-VM at /run (and would fail the run hook loudly);
# under CI's x64 emulation the ELF check is the strongest portable assertion.
binary="$SDK_DIR/../claude-agent-sdk-linux-arm64/claude"
if [ -x "$binary" ] && [ "$(head -c4 "$binary" | od -An -tx1 | tr -d ' \n')" = "7f454c46" ]; then
	r cli-binary PASS "linux-arm64 ELF present"
else
	r cli-binary FAIL "missing or not an ELF executable: $binary"
fi

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

# The Workspace must be writable by the runtime user (file tools + Bash cwd);
# the server install must not be.
if touch /home/developer/workspace/.smoke 2>/dev/null; then
	rm -f /home/developer/workspace/.smoke
	r workspace-writable PASS
else
	r workspace-writable FAIL "runtime user cannot write the Workspace"
fi
if touch "$APP/.smoke" 2>/dev/null; then
	rm -f "$APP/.smoke"
	r app-immutable FAIL "runtime user can write the server install"
else
	r app-immutable PASS "server install not writable by $(whoami)"
fi

exit "$fail"
