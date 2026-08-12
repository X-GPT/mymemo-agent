#!/usr/bin/env bash
# Records the header-level evidence #438 asks for, against a deployed origin.
#
#   ./infra/sandbox-origin/verify.sh https://mymemo-sandbox-origin.<subdomain>.workers.dev
#
# This checks what curl can see. The in-page checks (egress actually blocked,
# localStorage unreachable, parent DOM unreachable) need a browser: open the
# origin and read the probe table it renders.
set -euo pipefail

ORIGIN="${1:-}"
if [[ -z "$ORIGIN" ]]; then
	echo "usage: $0 <origin-url>" >&2
	exit 2
fi

fail=0
headers="$(curl -sSI "$ORIGIN/")"

check() {
	local label="$1" pattern="$2"
	if grep -qi -- "$pattern" <<<"$headers"; then
		printf '  ok    %s\n' "$label"
	else
		printf '  FAIL  %s\n' "$label"
		fail=1
	fi
}

echo "== $ORIGIN =="
check "TLS + 200"                     '^HTTP/[0-9.]* 200'
check "connect-src 'none'"            "connect-src 'none'"
check "default-src 'none'"            "default-src 'none'"
check "form-action 'none'"            "form-action 'none'"
check "base-uri 'none'"               "base-uri 'none'"
check "object-src 'none'"             "object-src 'none'"
check "sandbox allow-scripts"         'sandbox allow-scripts'
check "frame-ancestors present"       'frame-ancestors'
check "no allow-same-origin"          'content-security-policy'
if grep -qi 'allow-same-origin' <<<"$headers"; then
	echo "  FAIL  policy grants allow-same-origin"
	fail=1
fi

# The exfiltration ceiling is the union of every source list, so a single
# external host token anywhere reopens egress (CSP3 8.6). Flag any http(s)
# source outside frame-ancestors.
csp="$(grep -i '^content-security-policy:' <<<"$headers" | cut -d: -f2- | tr -d '\r')"
stripped="$(sed 's/frame-ancestors[^;]*//i' <<<"$csp")"
if grep -qE 'https?://' <<<"$stripped"; then
	echo "  FAIL  external host token in a fetch directive:"
	grep -oE 'https?://[^ ;]*' <<<"$stripped" | sed 's/^/          /'
	fail=1
else
	echo "  ok    no external host token in any fetch directive"
fi

# The origin must share nothing with mymemo.ai.
if [[ "$ORIGIN" == *"mymemo.ai"* ]]; then
	echo "  FAIL  origin is under mymemo.ai — must be a separate registrable domain"
	fail=1
else
	echo "  ok    separate registrable domain from mymemo.ai"
fi

if grep -qi '^set-cookie:' <<<"$headers"; then
	echo "  FAIL  origin sets a cookie"
	fail=1
else
	echo "  ok    origin sets no cookie"
fi

exit "$fail"
