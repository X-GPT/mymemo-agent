# Agent Runtime

The #732 Runtime, separate from v1's `apps/agentcore-runtime`. The front owns
sandbox lifecycle and workspace persistence; this process only invokes its
supplied session. No DynamoDB or transcript adapter is wired yet.

`POST /invocations` accepts the #732 payload (timestamps are Unix milliseconds;
`scope.kind` is `general`, `collection`, or `document`). `budgetUntil` includes
two minutes of grace after the ten-minute query budget. Every SDK message is
serialized unchanged as NDJSON, including thinking and Hand tool results.
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
six aliased tools, budget interruption, disconnect, Runtime-side failure, and
fatal sandbox loss with no SDK result. Hand checks exercise real local shell
commands through a fake sandbox transport, path confinement, edits and caps.

Set `CODE_INTERPRETER_ID` to a custom SANDBOX-mode interpreter and provide
the Runtime execution role with InvokeCodeInterpreter authority. The front
starts and stops sessions; the Runtime never restarts a lost session. See
`apps/agent-front` for the two-Turn workspace demo.

The always-loaded `hand` MCP server exposes Bash, Read, Write, Edit, Glob and
Grep via SDK aliases. `tools: []` disables built-ins; `allowedTools` lists only
the six `mcp__hand__*` targets. Model paths live under `/ws`, mapped to `ws/`
in the sandbox. Bash has a 120-second default and 600-second maximum timeout,
without background mode. Hand output is capped at 64 KiB; writes at 1 MiB.
File operations reject traversal and escaping symlinks. Binary reads return
size and MIME type; PDF page extraction uses Bash. Edits require one match.

Optional image env: `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`),
`OPENROUTER_DEFAULT_MODEL` (default `anthropic/claude-sonnet-5`), `PORT` (8080),
`LOG_LEVEL` (info). The CLI receives `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, and an explicitly empty `ANTHROPIC_API_KEY`, as in v1.
On AWS, `OPENROUTER_API_KEY_SECRET_ARN` selects Secrets Manager `AWSCURRENT`
bootstrap instead of the local direct key. Deployment, IAM and invocation steps:
[Runtime runbook](../../docs/runbooks/agent-runtime.md).
