# MicroVM probe results — ticket #646

Live run 2026-08-30, us-west-2, account 637423444544, on the versions the map pins
(SDK 0.3.251 / CLI 2.1.251, AL2023 `al2023-minimal` base, `al2023-1` microvm base).
Two images built — `probe-default-v2` (default caps) and `probe-allcaps-v2`
(`--additional-os-capabilities ALL`) — one VM from each, both since terminated.

## The load-bearing verdict: sandbox-mode Bash is viable — at DEFAULT caps

Identical on both images:

```
RESULT userns-max INFO max_user_namespaces=32056
RESULT unshare-userns PASS
RESULT bwrap PASS bubblewrap can create namespaces
```

**Unprivileged user namespaces and bubblewrap work in the MicroVM guest kernel with
NO special flag.** `--additional-os-capabilities ALL` made zero difference — the
default-caps VM passed exactly as the ALL-caps one did. So the destination clause
"Bash restricted by sandbox mode" holds, and the image does **not** need `ALL` caps
(which is good — `ALL` grants mounts/eBPF/etc. broadly). `bubblewrap` also installs
cleanly from AL2023 repos.

## Also proven (no model backend required)

| Result | Item | Verdict |
| --- | --- | --- |
| `policy-immutable PASS` | 4 (foundation) | non-root agent (uid 1000) **cannot** overwrite root-owned `/etc/claude-code/managed-settings.json` — #634's overwrite race is moot when the policy is baked root-owned |
| `cli-present PASS 2.1.251` | 1 | Claude Code CLI runs in-VM |
| suspend/resume + `marker-workspace PASS` / `marker-claude PASS` | 6 | suspend→resume in ~seconds each; **workspace and `~/.claude` survive intact** (same timestamp) — the persistent-VM state-staging premise holds |
| SSE round-trip via `/probe` | 7 | authenticated per-VM HTTPS endpoint (JWE `X-aws-proxy-auth` header) streams fine |
| `dns-resolve PASS` | 3 (partial) | DNS resolves through the default egress path |

## Findings / corrections captured

- **`get-microvm-image` requires the full ARN**, not the image name — the tutorial's use of the bare name fails with `Invalid ARN format`.
- **Build log group is `/aws/lambda-microvms/<name>`** (hyphen), not the tutorial's `/aws/lambda/microvms/<name>`.
- **`list-microvms` returns `items[]`**; `terminate-microvm` returns no `state`.
- **Confinement deny rules must use `Edit(...)`, not `Write(...)`.** The CLI warns `Permission deny rule (managed policy settings): Write(~/.claude/**) is not matched by file permission checks — only Edit`. The bundle's `Edit(...)` rules do the enforcing; the `Write(...)` entries are inert noise — dropped from `managed-settings.json`.
- **Transient `502 Bad Gateway` on `run-microvm`** — succeeded on immediate retry. Orchestration must retry `RunMicrovm`.
- First build failed on `ripgrep` (absent from AL2023 repos); a single bad package fails the whole `dnf install`. Fixed (dropped ripgrep, added `shadow-utils` for `useradd`).

## Deferred — and why (coupled to sibling tickets, not punted)

- **Item 4 full (file tools confined to cwd via actual CLI tool use)**: `claude -p` runs the agent loop, which needs a **model backend** to decide to call Read/Edit. No API key / gateway in the probe VM → the tool-exercising checks can't run. Verification couples to the **gateway ticket (#651)**; the static foundation (policy-tier immutability, corrected deny-rule syntax) is settled here.
- **Item 3 (egress lockdown)**: needs a VPC egress connector into private subnets with no NAT + SGs — that infrastructure is designed in **#651 / trust-boundary #647**. This run used managed `INTERNET_EGRESS`, so internet was open as expected (`egress-internet`/`egress-openrouter` INFO = open).
- **Item 5 (real model turn)**: needs the gateway — **#651**.
- **Item 8 (do suspended VMs consume the regional memory quota)**: pure observation, minor — fold into the lifetime-policy ticket (#650).

## Net

Every platform-feasibility question answerable without a model backend or VPC infra is
answered, decisively and positively. The architecture's riskiest unknown — does the
guest kernel permit the sandboxing bubblewrap needs — is a clean **yes at default caps**.
