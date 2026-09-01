# Configuration and operations

Use this guide when changing deployment configuration, runtime bootstrap, secrets, limits, or AWS operations. Environment validation code remains authoritative.

## AWS CLI

For local operator commands, always use the `mymemo` profile:
`aws --profile mymemo ...`.

GitHub Actions configures short-lived credentials by assuming the deploy role
through OIDC. Workflow commands and the scripts they invoke use plain `aws` so
the CLI reads those assumed-role credentials; they must not select the local
`mymemo` profile.

## AgentCore dispatch consumer Lambda

Required by the consumer entrypoint:

- `AWS_REGION`: region for SSM and Bedrock AgentCore clients
- `AGENT_DATABASE_URL`: the passwordless writable `mymemo_agent` URL
- `DB_PASSWORD_SECRET_ARN`: exact same-account, same-region RDS password-secret ARN; resolve only `AWSCURRENT`, extract its `password` JSON key, and require `sslmode=verify-full`
- `AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME`: `/mymemo/agentcore-dispatch/<environment>/enabled`; its only enabling value is exactly `enabled`, and dispatch fails closed on missing, unreadable, or other values
- `RDS_CA_BUNDLE_PATH` and `NODE_EXTRA_CA_CERTS`: `/var/task/rds-global-bundle.pem`, the digest-pinned RDS trust bundle packaged with the Lambda
- `AGENTCORE_RUNTIME_ARN`: exact AgentCore Runtime invoked with `DEFAULT` and the Conversation UUID as Runtime-session identity. Do not give the publisher this consumer-only authority.

## AgentCore Runtime

Required non-secret bootstrap values:

- `AWS_REGION`, `AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME`, `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, `WORKER_E2B_TEMPLATE`, and `ARTIFACT_BUCKET`
- `AGENT_DATABASE_URL`: the passwordless writable `mymemo_agent` URL; it must not contain a password
- `DB_PASSWORD_SECRET_ARN`, `KB_DATABASE_URL_SECRET_ARN`, `OPENROUTER_API_KEY_SECRET_ARN`, `E2B_API_KEY_SECRET_ARN`, and `REDIS_URL_SECRET_ARN`: exact Secrets Manager ARNs. Do not put the corresponding secret values in the Runtime environment. The RDS password is read from the `password` JSON key; both database URLs require `sslmode=verify-full`.
- `RDS_CA_BUNDLE_PATH` and `NODE_EXTRA_CA_CERTS`: absolute path to the digest-pinned RDS bundle baked into the image

Runtime Downloadable artifact keys use the standard `objects/` production namespace; there is no runtime-specific prefix setting.

Optional:

- `PORT` (default `8080`)
- `LOG_LEVEL` (default `info`)
- `WORKER_HEARTBEAT_INTERVAL_MS` (default `15000`)

Production Terraform also requires `fck_nat_ami_id`, an exact reviewed ARM64
AMI ID owned by the official fck-nat publisher in `aws_region`. Do not replace
it with a latest-image lookup.

Runtime shutdown grace is fixed at 30 seconds and concurrency is fixed at one execution.

## Harness-hosted AI SDK chat (local chat-api only)

The local composition (`apps/chat-api/local/index.ts`) reads these through
`loadHarnessConfigFromEnv`; the production `ApiConfig` never reads them.

Required:

- `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID`: passed explicitly to `createVercelSandbox`; `@vercel/sandbox` does not read them from the environment
- `OPENROUTER_API_KEY`: set in the chat-api process as `ANTHROPIC_AUTH_TOKEN` for the Claude Code adapter (`auth: 'direct'`); the sandbox receives only the brokered placeholder
- `KB_DATABASE_URL`: secret; the read-only `mymemo_kb` URL the document tools (`ListDocuments`, `SearchDocuments`, `LoadDocuments`) query in the chat-api process, passed to `pg` as-is. The Compose `chat-api` service exports it inline.

Optional:

- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`): set as `ANTHROPIC_BASE_URL`
- `OPENROUTER_DEFAULT_MODEL` (default `anthropic/claude-sonnet-5`): model the Claude Code adapter runs; the request `model` literal is validated but the adapter is configured once at boot
- `HARNESS_SANDBOX_TIMEOUT_MS` (default `600000`): maximum wall-clock lifetime of one sandbox session
- `HARNESS_SANDBOX_REGION` (default `iad1`): Vercel region; snapshots are region-bound

Compose requires the Vercel triple and `OPENROUTER_API_KEY` for the `chat-api`
service and sets `KB_DATABASE_URL` inline.

## Chat API

Required:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database. It is deliberately not named `DATABASE_URL`, which denotes the read-only KB credential elsewhere. It is separate from AgentCore Runtime's read-only `mymemo_kb` credential. The process fails at startup when it is absent. `bun run db:migrate` in `apps/chat-api` applies migrations owned by `packages/agent-db` through its exported `MIGRATIONS_DIR`.
- `STATSIG_SERVER_SECRET`: required production exposure-gate secret
- `ARTIFACT_BUCKET`: private artifact bucket; chat-api receives read-only object access
- `AWS_REGION`: artifact S3 region
- `REDIS_URL`: authenticated `rediss://` URL. Missing, malformed, unauthenticated, or non-TLS values fail startup. Never log it.

Optional:

- `LOG_LEVEL` (default `info`)
- `PORT` (default `3000`)
- `OPENROUTER_API_KEY`: secret; the real model credential the `/v2/gateway` route injects on forwarded requests (ADR-0034). Never delivered to a VM, image, or Checkpoint. While unset the gateway route answers 503.
- `GATEWAY_TOKEN_SECRET`: secret; HMAC key for per-Conversation gateway tokens (minted at VM launch, verified on every gateway request — both in chat-api). While unset the gateway route answers 503.
- `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api`): upstream the gateway forwards to

chat-api has no AgentCore dispatch queue or SSM parameter configuration. Admission ends after the transactional Postgres outbox write; publisher and consumer processes own queue delivery and the dispatch kill switch.

The local Compose target starts `apps/chat-api/local/index.ts`, which injects an always-open development gate. The production entrypoint and image contain no configuration switch to select that composition.
- `DB_PASSWORD`: splice into a passwordless `AGENT_DATABASE_URL`
- `DB_SSL` (default on; `disable` only for local non-TLS Postgres)
- `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` (default off): when exactly `true`, allow unauthenticated `redis://` only for `localhost`, `127.0.0.1`, or `[::1]` in integration tests

## In-VM server

The trusted In-VM server (`apps/in-vm-server`, spec #654) serves one
Conversation per process. One configuration contract, two delivery modes:
locally the values below are plain env vars and the server configures at
startup (selected by `MYMEMO_CONVERSATION_ID` being present); in the MicroVM
image (#666) the server boots unconfigured and the platform `/run` lifecycle
hook delivers a `runHookPayload` — a JSON object of exactly these env names —
which configures Turn serving before the platform routes any traffic. The
image bakes only shared, non-secret environment (`WORKSPACE_DIR`,
`SMOKE_SCRIPT`, `NODE_EXTRA_CA_CERTS`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY`);
everything per-Conversation or secret rides the payload into the trusted
process only.

Required:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database; `DB_PASSWORD` and `DB_SSL` follow the shared database conventions
- `REDIS_URL`: authenticated `rediss://` URL for the v2 Turn Live Stream lane; `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` is the same loopback-only escape hatch as chat-api's
- `MYMEMO_USER_ID`, `MYMEMO_CONVERSATION_ID`: the Conversation this VM serves
- `WORKSPACE_DIR`: the Workspace — the cwd the confined file tools and sandboxed Bash act in
- `MODEL_BASE_URL`, `MODEL_API_KEY`, `MODEL`: model access held by the trusted process — locally a direct provider base URL/key; in production the chat-api `/v2/gateway` URL and the per-Conversation gateway token, with no design change

Optional: `PORT` (default `8080`), `LOG_LEVEL` (default `info`) — listener
settings read from the plain environment at process start (never the payload:
the listener is already bound when `/run` arrives).

The spawned Claude Code CLI never receives the process environment: it gets
the credential-free allowlist built in `src/query-options.ts`, so no
data-plane secret can reach the untrusted surface.

## AgentCore dispatch publisher

The dedicated publisher ECS task requires only:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database
- `AWS_REGION`: region for SSM and SQS
- `AGENTCORE_DISPATCH_QUEUE_URL`: encrypted standard AgentCore dispatch queue URL
- `AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME`: fail-closed `/mymemo/agentcore-dispatch/<environment>/enabled` SSM gate whose only enabling value is exactly `enabled`

`AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS` optionally changes the two-second tick interval. `LOG_LEVEL`, `DB_PASSWORD`, and `DB_SSL` follow the shared database conventions. The publisher has its own image, ECS service, task role, execution role, and outbound-only security group. It does not receive KB, model, E2B, artifact, or Redis authority.

## Agent maintenance

The always-on maintenance ECS service owns global queued-Run expiration,
Reclamation, E2B orphan cleanup, and artifact-object cleanup. It receives no
KB, OpenRouter, Redis, Dispatch, or Run-serving configuration.

Required:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database
- `DB_PASSWORD`: RDS-managed password injected by ECS
- `E2B_API_KEY`: credential used only to delete orphaned sandboxes
- `ARTIFACT_BUCKET`: private artifact bucket; maintenance receives delete-only object access
- `AWS_REGION`: artifact S3 region

Optional:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `PORT` | `8080` | `/health` port |
| `LOG_LEVEL` | `info` | Log level |

Maintenance cadence and cleanup safety bounds are fixed in code so deployments
cannot silently weaken them.
