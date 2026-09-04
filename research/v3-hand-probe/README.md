# v3 hand probe (wayfinder #708) — throwaway

Answers: *does remote Bash + file operations through the authenticated MicroVM HTTPS endpoint work well enough to be the v3 hand?*

Shape under test: the **Agent Runner** (here: this Mac) runs the real Claude Agent SDK `query()` with every built-in tool off (`tools: []`), an in-process MCP server `hand` whose handlers call the **Sandbox** (a Lambda MicroVM running `image/hand.ts`, non-root, no credential, no egress), `toolAliases` routing model-emitted `Bash`/`Read`/… to `mcp__hand__*`, and a `dontAsk` allowlist.

## Files
- `image/` — the Sandbox image: `Dockerfile` (AL2023 + node22 + bun), `hand.ts` (bash / read / write / edit / glob / grep, internal `GET /export`, no-op lifecycle hooks), `workspace/` (an npm-test fixture with a deliberate bug).
- `runner/probe.ts` — one real model Turn: "run `npm test`, fix the bug, rerun". Logs every SDK message and hand-call latency.
- `runner/smoke.ts` — direct hand measurements, no model: per-op latency, 1 MiB output cap, timeout kill, path escape, egress + IMDS negative controls, SSE streaming gaps, export size.
- `runner/fake-model.ts` — Anthropic-Messages SSE fake for mechanics-only runs (no key). `FAKE_ALIAS=1` makes it emit built-in names to exercise `toolAliases`.
- `register.sh`, `run-vm.sh` — **operator-run** (the auto-mode classifier blocks them in agent sessions).

## Operator steps (≈15 min)
```bash
cd research/v3-hand-probe
./register.sh                                   # zip image/ → S3 → create-microvm-image; polls until CREATED
eval "$(./run-vm.sh)"                           # RunMicrovm, image-default egress + empty execution role; exports MICROVM_ID HAND_URL HAND_TOKEN HAND_PORT
cd runner && bun install
bun run smoke.ts                                # mechanics + negative controls against the real Sandbox
export ANTHROPIC_BASE_URL=https://openrouter.ai/api ANTHROPIC_AUTH_TOKEN=<openrouter key>   # never paste the key into the chat
MODEL=anthropic/claude-sonnet-4.5 bun run probe.ts   # the real Turn
../run-vm.sh terminate "$MICROVM_ID"
```
Token lifetime is 30 min; re-mint with `./run-vm.sh token "$MICROVM_ID"` and re-export `HAND_TOKEN`.

## Local mechanics run (no AWS, no key)
```bash
cp -R image/workspace /tmp/ws && (cd image && WORKSPACE_DIR=/tmp/ws bun run hand.ts &) && (cd runner && bun run fake-model.ts &)
cd runner && HAND_URL=http://localhost:8080 bun run smoke.ts
HAND_URL=http://localhost:8080 ANTHROPIC_BASE_URL=http://localhost:8787 RUNNER_CWD=/tmp/ws bun run probe.ts
```
Results live in `RESULTS.md`.
