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

## Agent-query Runtime

The non-production synchronous Runtime requires `AGENT_DATABASE_URL`,
`E2B_API_KEY`, and `WORKER_E2B_TEMPLATE`. `PORT` defaults to `8080` and
`LOG_LEVEL` to `info`. Chat API mounts the staged route in every composition;
`AGENT_QUERY_RUNTIME_ARN` enables execution through this Runtime. Without it,
the route returns `503` before admission.

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
- `AGENT_QUERY_RUNTIME_ARN`: enables the staged direct-response Runtime; production omits it until the hard swap

chat-api has no AgentCore dispatch queue or SSM parameter configuration. Admission ends after the transactional Postgres outbox write; publisher and consumer processes own queue delivery and the dispatch kill switch.

The local Compose target starts `apps/chat-api/local/index.ts`, which injects an always-open development gate. The production entrypoint and image contain no configuration switch to select that composition.
- `DB_PASSWORD`: splice into a passwordless `AGENT_DATABASE_URL`
- `DB_SSL` (default on; `disable` only for local non-TLS Postgres)
- `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` (default off): when exactly `true`, allow unauthenticated `redis://` only for `localhost`, `127.0.0.1`, or `[::1]` in integration tests

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
