# Lambda front — Conversation lifecycle

Implements issue #735 / Spec #732 alongside v1. No imports from chat-api.
Identity parsing, Summary and the Statsig gate are copied; the gate also checks
Statsig's resolved `isSuccess` result. Only creation consults the gate.

## Local development

From the repository root:

```sh
bun install
docker compose -f apps/agent-front/compose.yml up -d
bun run --cwd apps/agent-front db:init
bun run --cwd apps/agent-front dev
```

DynamoDB Local is in-memory on localhost:8000; restarting it loses local data.
`db:init` creates `mymemo-conversations` once per container lifetime. The local
front listens on port 3000 with an explicitly open development gate. Supply
`X-Member-Code` and `X-Partner-Code`, optionally `X-Team-Code`.

```sh
TEST_DYNAMODB_ENDPOINT=http://127.0.0.1:8000 bun test apps/agent-front
bunx tsc --project apps/agent-front/tsconfig.json
bunx biome check apps/agent-front
```

The integration suite creates an isolated table on DynamoDB Local. Without
`TEST_DYNAMODB_ENDPOINT`, it skips; the dedicated CI job supplies the endpoint.

## Lambda entry point and deployment handoff

`src/lambda.ts` exports `handler` for both Hono `streamHandle` requests and a
scheduled invocation with payload `{"source":"mymemo.cleanup"}`. HTTP request
bodies cannot select the sweep. Required env: `CONVERSATION_TABLE`,
`STATSIG_SERVER_SECRET_ARN`, `WORKSPACE_BUCKET`, and the normal AWS SDK region/role environment.
Production always uses the fail-closed Statsig gate and flushes events before
return. It does not accept a local DynamoDB endpoint or an open-gate switch.

See [the deployment and signing-proxy runbook](../../docs/runbooks/agent-front.md). Terraform configures Node.js 22 / arm64, an `AWS_IAM`
`RESPONSE_STREAM` Function URL, a 14-minute timeout, the Statsig
`linux-arm64-gnu` native binary, and a five-minute Scheduler invocation. Only
the trusted mymemo-service caller may invoke the URL; identity headers are
trusted assertions, not public authentication. The table definition lives in
`infra/terraform/dynamodb.tf`, with PITR, deletion protection, two GSIs and no TTL.

## Slice boundaries

The seven non-send routes are mounted. Since this slice cannot produce a Turn
or an artifact, history and artifact lists are empty and artifact downloads
return 404; `POST …/messages` belongs to the next ticket. All id routes check
ownership and tombstones before body/query validation, including the future
send route. Summary preserves v1's string `scope`; the stored Scope also holds
the frozen document or collection id.

Listing queries GSI1 in descending activity order and strongly re-reads each
base item before serving it, hiding stale deleted/archived index entries.
Title search is case-insensitive substring matching. Cursors bind the owner,
archive partition and search and advance through evaluated index rows. GSIs
remain eventually consistent: a new or moved Conversation may appear later.
Rename and Archive never change activity. Archive may proceed during a Turn;
delete admits only an absent or expired `processing` (ISO UTC `until`).

The sweep queries the sparse GSI2 and deletes each partition's children, then
its tombstone. A failed delete propagates for Scheduler retry and preserves
the tombstone. The deployed handler deletes all three Conversation S3 prefixes and the exact
transcript key before removing any DynamoDB items.
