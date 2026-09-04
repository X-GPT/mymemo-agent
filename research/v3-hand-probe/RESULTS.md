# RESULTS — v3 hand probe (#708)

## 1. Local mechanics (Mac as Runner, hand on localhost, fake model) — 2026-09-03 — PASS

| Check | Result |
|---|---|
| `tools: []` + in-process `hand` MCP | `system:init` lists exactly `mcp__hand__{bash,edit,glob,grep,read,write}` |
| Scripted Turn: `npm test` → edit → `npm test` | `result: success`, 3 turns, 4.0–6.2 s wall clock; hand calls 0.21 s (edit) + 1.0–1.6 s (`npm test`) |
| `toolAliases` (fake emits `Edit`, `Bash`) | Routed to `mcp__hand__edit` / `mcp__hand__bash`; results returned. **Schemas must use the built-ins' parameter names** (`file_path`, `old_string`, `new_string`, `replace_all`, `command`, `pattern`, `path`) — alias is name-only. Verified after renaming. |
| bash echo round-trip (local) | 68–121 ms |
| 1 MiB stdout | capped at 64 KiB, `truncated: true`, 78 ms |
| `sleep 30` with 2 s timeout | killed, exit 137, `timedOut: true` |
| `../../etc/passwd` | 400 `path escapes workspace` |
| SSE `/bash/stream`, 5 ticks | frames arrive with ~1.0 s gaps (live, not buffered) |
| `GET /export` | 200, tar.gz (10 KiB for the fixture) |
| egress / IMDS controls | not meaningful locally (Mac has internet) — see §2 |

## 2. Real Sandbox (operator-run: `register.sh`, `run-vm.sh`, `smoke.ts`, `probe.ts`) — PENDING

Fill from the pasted outputs: per-op latency through the JWE endpoint; SSE gaps through the proxy; `example.com` and IMDS from inside the Sandbox (expect both FAIL); token expiry mid-Turn; suspend mid-call; the real model's handling of `mcp__hand__*` tools and of the built-in-name aliases; `npm test` wall clock on ARM64.

## 3. Verdict — PENDING §2
