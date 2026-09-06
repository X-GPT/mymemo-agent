# Agent Runtime

Issue #736's no-tools Runtime, separate from v1's `apps/agentcore-runtime`.
No DynamoDB, workspace, sandbox lifecycle, or transcript adapter is wired yet.

`POST /invocations` accepts the #732 payload (timestamps are Unix milliseconds;
`scope.kind` is `general`, `collection`, or `document`). `budgetUntil` includes
two minutes of grace after the ten-minute query budget. Every SDK message is
serialized unchanged as NDJSON, including thinking and denied tool results.
A terminal SDK result ends the single-prompt query; Runtime failures emit one
`mymemo.error` line. Budget expiry interrupts the SDK so its result survives;
caller disconnect closes the query. Both cases close the HTTP server after
cleanup. `/ping` reports `Healthy` or `HealthyBusy`; concurrency is one.

The SDK and native CLI are pinned together at 0.3.251. The `claude-agent-sdk`
npm alias keeps v1's SDK at 0.3.233 when Bun hoists workspace dependencies. Query settings are
isolated in a per-Turn temporary `CLAUDE_CONFIG_DIR`, removed after CLI cleanup.
The image's fixed empty project directory is `/opt/mymemo/project`.

## Verify

From the repository root:

```sh
bun install --frozen-lockfile
bun test apps/agent-runtime --timeout=30000
bunx tsc -p apps/agent-runtime
bunx biome check apps/agent-runtime
docker build --platform linux/arm64 -f apps/agent-runtime/Dockerfile -t mymemo-agent-runtime .
```

Tests run the pinned CLI against the fake Anthropic Messages server adapted
from #730's `sdk-session-probe.ts`, without a model key. They compare every
forwarded message with the SDK iterator, exercise thinking and an attempted
disabled tool, budget interruption, disconnect, and Runtime-side failure.

For one real-model smoke, export `OPENROUTER_API_KEY` securely, then:

```sh
docker run --rm --platform linux/arm64 -p 8080:8080 \
  -e OPENROUTER_API_KEY mymemo-agent-runtime
# In another terminal:
bun run apps/agent-runtime/smoke.ts
```

Optional image env: `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`),
`OPENROUTER_DEFAULT_MODEL` (default `anthropic/claude-sonnet-5`), `PORT` (8080),
`LOG_LEVEL` (info). The CLI receives `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, and an explicitly empty `ANTHROPIC_API_KEY`, as in v1.
This app does not change production deployment or secret bootstrap before cutover.
