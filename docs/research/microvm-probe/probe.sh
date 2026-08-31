#!/usr/bin/env bash
# In-VM measurements for ticket #646. Emits one `RESULT <item> <PASS|FAIL|INFO> <detail>`
# line per check. Runs as the non-root `developer`. No arguments; reads env:
#   GATEWAY_URL   - the egress gateway base (for the model-call arm); optional
#   MARKER_PHASE  - "plant" (first boot) or "verify" (after suspend/resume or rehydrate)
set -uo pipefail
r() { echo "RESULT $1 $2 ${3:-}"; }
WORK="$HOME/workspace"; mkdir -p "$WORK"; cd "$WORK" || exit 1

# --- Item 2 (load-bearing): unprivileged user namespaces + bubblewrap ---------
uns=$(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo "?")
r userns-max "INFO" "max_user_namespaces=$uns"
if unshare -Urn true 2>/dev/null; then r unshare-userns PASS; else r unshare-userns FAIL "unshare -Urn denied"; fi
if bwrap --unshare-all --ro-bind / / --dev /dev true 2>/dev/null; then
  r bwrap PASS "bubblewrap can create namespaces"
else
  r bwrap FAIL "bwrap failed — sandbox-mode Bash unavailable at this capability level"
fi

# --- Item 1: SDK loads in-VM -------------------------------------------------
# SDK is installed globally (npm -g); require() must see the global modules dir.
v=$(NODE_PATH="$(npm root -g)" node -e 'console.log(require("@anthropic-ai/claude-agent-sdk/package.json").version)' 2>/dev/null)
[ -n "$v" ] && r sdk-import PASS "claude-agent-sdk@$v" || r sdk-import FAIL "require() threw (check NODE_PATH/global install)"
command -v claude >/dev/null && r cli-present PASS "$(claude --version 2>/dev/null | head -1)" || r cli-present FAIL

# --- Item 4: file-tool confinement (permission bundle actually denies escape) --
# NOTE: `claude -p` runs the agent LOOP, which needs a model backend to decide to
# call Read/Edit. Without ANTHROPIC_API_KEY or a gateway (GATEWAY_URL), these two
# checks cannot exercise the tools and their PASS/FAIL is meaningless — item 4's
# CLI-driven verification is coupled to the gateway (#651). `policy-immutable`
# below needs NO model and is the standalone confinement signal this probe trusts.
# Uses the CLI in print mode with the confinement flags; expects a DENY on escape.
esc="/etc/hostname"; out=$(claude -p "Read the file $esc and print its first line" \
  --setting-sources '' --permission-mode dontAsk --allowed-tools 'Read(./**)' 2>&1)
echo "$out" | grep -qiE 'denied|not permitted|cannot read' \
  && r confine-read-escape PASS "out-of-cwd Read denied" \
  || r confine-read-escape FAIL "escape not denied: $(echo "$out" | tr '\n' ' ' | cut -c1-120)"
# config-path write must be denied by the managed policy tier
cw=$(claude -p "Write the text hi to ~/.claude.json" \
  --setting-sources '' --permission-mode dontAsk --allowed-tools 'Edit(./**)' 2>&1)
echo "$cw" | grep -qiE 'denied|permission settings' \
  && r confine-config-write PASS "~/.claude.json write denied by policy tier" \
  || r confine-config-write FAIL "config write not denied"
# policy file itself must be non-writable by the agent user
if echo x > /etc/claude-code/managed-settings.json 2>/dev/null; then
  r policy-immutable FAIL "agent overwrote the policy file"; else r policy-immutable PASS "policy file root-owned, agent cannot write"; fi

# --- Item 3: egress reality (only meaningful under the VPC connector, no NAT) --
probe_host() { timeout 5 bash -c "echo > /dev/tcp/$1/443" 2>/dev/null && echo open || echo blocked; }
r egress-internet "INFO" "example.com:443=$(probe_host example.com) (want blocked under lockdown)"
r egress-openrouter "INFO" "openrouter.ai:443=$(probe_host openrouter.ai) (want blocked; only gateway allowed)"
[ -n "${GATEWAY_URL:-}" ] && r egress-gateway "INFO" "gateway reachable=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$GATEWAY_URL/healthz" 2>/dev/null || echo err)"
# DNS through the connector (UDP-block quirk): resolve an RDS-style name
getent hosts amazonaws.com >/dev/null 2>&1 && r dns-resolve PASS "getent resolves" || r dns-resolve FAIL "DNS broken (UDP-block?)"

# --- Item 6: suspend/resume + rehydrate persistence markers -------------------
MARK="$WORK/.probe-marker"; CMARK="$HOME/.claude/.probe-marker"
if [ "${MARKER_PHASE:-plant}" = "plant" ]; then
  mkdir -p "$HOME/.claude"; date +%s | tee "$MARK" > "$CMARK"; r marker-plant PASS "planted at $(cat "$MARK")"
else
  [ -f "$MARK" ] && r marker-workspace PASS "workspace survived: $(cat "$MARK")" || r marker-workspace FAIL "workspace marker gone"
  [ -f "$CMARK" ] && r marker-claude PASS "~/.claude survived" || r marker-claude FAIL "~/.claude marker gone"
fi
r done INFO "probe complete"
