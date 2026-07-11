# ADR-0008 hard-cutover verification

This is the release record for [ADR-0008](../adr/0008-token-streaming-redis-live-lane.md),
parent spec [#243](https://github.com/X-GPT/mymemo-agent/issues/243), and
verification ticket [#250](https://github.com/X-GPT/mymemo-agent/issues/250).
The exposure gate must remain disabled for users until every release-evidence
row below has a durable link.

## Executable contract proof

The client fixture at `scripts/smoke/client-contract.ts` is the server-side
conformance example. Its tests prove that a client:

- appends cursorless, contiguous `text_delta` frames provisionally by opaque
  `messageId` and `deltaIndex`;
- replaces that preview, or creates a message, from the cursor-bearing
  `text_commit` authority;
- ignores preview after commit and reconciles multiple message ids separately;
- clears every uncommitted preview on `done`, `canceled`, and `error`; and
- rejects the former cursor-bearing/text-only durable `text_delta` shape and
  an `assistant_text` client alias.

Run the fixture and deployed-smoke contract tests together:

```bash
bun test scripts/smoke/client-contract.test.ts scripts/smoke/agent-conversation-smoke.test.ts
```

Cancellation, error, and Live-transport failure stay deterministic rather than
being induced in staging. The same full-suite run covers:

- client cleanup after `canceled` and `error` in `client-contract.test.ts`;
- worker cancellation abandoning open preview, and publication failure leaving
  the Run `done`, in `apps/agent-worker/src/sdk/run-processor.test.ts`;
- subscriber failure degrading to durable projection, plus terminal preview
  purge, in `apps/chat-api/src/features/run-events/project-run.test.ts`; and
- real Redis failure leaving the active Run `done` from Postgres in
  `apps/chat-api/src/features/run-events/redis-live-text.integration.test.ts`.

The deployed smoke performs two real Runs. For each Run it requires
`conversation_id` and `run_id` before text, reconciles every frame through the
same fixture, proves exact committed text from the requested response shape,
and reconnects from the durable Run-start cursor. Reconnect must reproduce the
same committed messages and `done` without any `text_delta`.

## Staging procedure

Run from a network location that can reach `AGENT_SMOKE_BASE_URL`. The smoke
identity must be allowed by Statsig.

With the Redis lane enabled:

```bash
AGENT_SMOKE_PREVIEW_MODE=required scripts/deploy/prod_smoke.sh
```

This mode requires at least one cursorless preview before a cursor-bearing
commit. Record the command output plus healthy chat-api and agent-worker task
status in the Live-enabled evidence row.

Then use the [Live preview runbook](../runbooks/live-preview.md#disable-the-redis-lane)
to set `live_preview_enabled=false`, review/apply the plan, and roll both ECS
services. With the lane disabled:

```bash
AGENT_SMOKE_PREVIEW_MODE=forbidden scripts/deploy/prod_smoke.sh
```

This mode fails if any preview appears. The exact commits, durable reconnect,
and `done` must still pass. Record the command output, the reviewed Terraform
plan, and healthy status for both services in the Redis-disabled evidence row.

Restore the lane using the
[runbook procedure](../runbooks/live-preview.md#restore-the-redis-lane) after
capturing the disabled result.

## Release evidence

| Gate | Required evidence | Link |
| --- | --- | --- |
| Live-enabled staging | `preview=required` smoke output; healthy chat-api and agent-worker | Pending — do not enable exposure |
| Redis-disabled staging | `preview=forbidden` smoke output; reviewed disable plan; both services healthy | Pending — do not enable exposure |
| Production client | Contract tests, CI, and released client version from [mymemo-web#66](https://github.com/X-GPT/mymemo-web/issues/66) | Pending — do not enable exposure |
| Repository validation | Full tests, type checks, Biome checks, Terraform format/validation, disposable Redis suite | Link the final CI run for #250 |

The release owner must replace every `Pending` cell with durable evidence and
link this completed record from #250 before enabling
`mymemo_agent_split_runtime_enabled` for users.

## Rollback

If Live preview degrades while durable commits remain healthy, use the
[Redis-lane kill switch](../runbooks/live-preview.md#disable-the-redis-lane).
This removes `REDIS_URL` from both trusted services and keeps Postgres delivery
authoritative. If `text_commit`, terminal Run events, or service health also
fail, follow the
[Postgres-path escalation criteria](../runbooks/live-preview.md#recognize-a-postgres-path-incident)
instead of treating the incident as Live-only.
