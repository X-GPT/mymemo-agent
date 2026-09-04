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

## 2. Real Sandbox (image `mymemo-agent-prod-microvm-probe-v3-hand` v3.0 = commit 209b402, default INTERNET_EGRESS connector, empty execution role) — 2026-09-03

Launched with `run-vm.sh` from this Mac (RunMicrovm + CreateMicrovmAuthToken were NOT blocked by the auto-mode classifier; `create-microvm-image` was not either — only the first attempt was). Registration gotchas that cost three failed builds: (1) the v2 build role grants CloudWatch writes only on `/aws/lambda-microvms/mymemo-agent-prod-microvm*`, and a build that cannot create its log group **fails with no log and the reason "container image build failed"** — name the image under that prefix; (2) the lifecycle hooks are `POST /aws/lambda-microvms/runtime/v1/{ready|run|resume|suspend|terminate}`, and a 404 on `ready` fails the image build ("Ready hook check failed: HTTP 4xx").

### 2.1 `smoke.ts` through the JWE endpoint (Mac → us-west-2)

| Check | Result |
|---|---|
| `/health` | 288 ms |
| `bash echo` ×3 | **3532 ms first call** (in-VM `durationMs` 2966 — first `bash -l` spawn), then 101 ms and 214 ms (in-VM 9 / 39 ms) → **~100–200 ms endpoint overhead per call** |
| `bash npm test` | 9151 ms (cold node on ARM64; test itself 3 ms) |
| `read` / `glob` / `grep` | 185 / 130 / 115 ms |
| `../../etc/passwd` | 400 `path escapes workspace` |
| 1 MiB stdout | capped at 64 KiB, `truncated: true`, 97 ms |
| `sleep 30`, 2 s timeout | killed, exit 137, 2089 ms |
| `curl example.com` | 200 — **informational**: this run used the image-default INTERNET_EGRESS connector (offline shape not re-proven here; v2 proved it on the no-NAT connector) |
| IMDS `169.254.169.254` | reachable; answers "No MMDS token provided" (Firecracker MMDS, session-token required). Credentials path not exercised; the execution role is policy-less so it yields nothing usable either way |
| `GET /export` | 200, 450-byte tar.gz, 375 ms |

### 2.2 `probe.ts` — one real model Turn (OpenRouter `anthropic/claude-sonnet-4.5`, Runner on the Mac)

Prompt: run `npm test`, fix the bug in the source, rerun. **`result: success`, 7 model turns, 27.3 s wall clock, $0.035.** The model used the hand tools unprompted and by their MCP names — no alias fallback observed: `mcp__hand__bash npm test` (1179 ms) → `read math.test.js` (31 ms) → `glob` (31 ms) → `read math.js` (30 ms) → `edit` (32 ms) → `bash npm test` (619 ms) → summary. Endpoint overhead per call after warm-up: ~30 ms for file ops, ~0.6–1.2 s for `npm test` (dominated by node startup on ARM64, not the endpoint). Model latency dominates the Turn: ~2–5 s of thinking between calls.

## 3. Verdict — **VIABLE, with constraints**

The hand shape works: a bare MicroVM with a ~60-line tool server, the SDK loop outside, every built-in off, `toolAliases` as a safety net. Constraints the spec must carry:

1. **Warm-up.** The first `bash` spawn in a fresh Sandbox took ~3 s (`bash -l` + login init); every later call was 30–200 ms. The Runner should fire one warm-up call at Sandbox creation/resume, before the model's first tool call.
2. **Tool results are whole.** No streaming to the model (SDK semantics); the Runner caps output (64 KiB in the hand, chars-capped again Runner-side under the SDK's 25k-token spill-to-file path, which v3 cannot use since there is no local `Read`).
3. **Schemas mirror the built-ins' parameter names** (`file_path`, `old_string`, `new_string`, `replace_all`, `command`, `pattern`, `path`) because `toolAliases` routes by name only. Verified with a fake model emitting `Edit`/`Bash`.
4. **Image registration gotchas** (§2 header): the build role's log-group grant is name-scoped and a build that cannot log fails silently; hooks are POSTs under `/aws/lambda-microvms/runtime/v1/`. The v3 image pipeline inherits both.
5. **Offline shape not re-proven here** — this run used the image-default INTERNET_EGRESS connector for simplicity; the no-NAT connector was verified in v2 (#651) and the pre-cutover gate re-verifies it. IMDS is reachable (MMDS, token-gated); the empty execution role is the control.
6. **Timeouts and caps are Runner-side policy**: per-call timeout (the hand kills at `timeoutMs`), output cap, file-count cap on glob (500). None need the Sandbox's cooperation.

Not measured (moved to the lifecycle ticket as Runner-client questions): token expiry mid-call, suspend mid-call.
