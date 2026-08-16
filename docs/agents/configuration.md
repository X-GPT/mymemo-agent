# Configuration and operations

Use this guide when changing deployment configuration, runtime bootstrap, secrets, limits, or AWS operations. Environment validation code remains authoritative.

## AWS CLI

Always use the `mymemo` profile: `aws --profile mymemo ...`.

## AgentCore canary dispatch

Required by publisher and consumer entrypoints:

- `AWS_REGION`: region for SSM and SQS clients
- `CANARY_AGENT_DATABASE_URL_SECRET_ARN`: exact same-account, same-region Secrets Manager ARN for the writable `mymemo_agent` URL; resolve only `AWSCURRENT`, and require `sslmode=verify-full`
- `CANARY_DISPATCH_QUEUE_URL`: encrypted standard canary dispatch queue URL
- `CANARY_ENABLED_PARAMETER_NAME`: SSM parameter whose only enabling value is exactly `enabled`; fail closed on missing, unreadable, or other values
- `RDS_CA_BUNDLE_PATH` and `NODE_EXTRA_CA_CERTS`: `/var/task/rds-global-bundle.pem`, the digest-pinned RDS trust bundle packaged with the Lambda

Required only by consumer, manual-replay, and acquisition entrypoints:

- `CANARY_AGENT_RUNTIME_ARN`: exact AgentCore Runtime invoked with `DEFAULT` and the Conversation UUID as Runtime-session identity. Do not give the publisher this consumer-only authority.

## AgentCore canary runtime

Required non-secret bootstrap values:

- `AWS_REGION`, `CANARY_ENABLED_PARAMETER_NAME`, `OPENROUTER_BASE_URL`, `OPENROUTER_DEFAULT_MODEL`, `WORKER_E2B_TEMPLATE`, and `ARTIFACT_BUCKET`
- `CANARY_ARTIFACT_OBJECT_KEY_PREFIX`: deployment-owned `objects/agentcore-canary` namespace; Terraform must scope generated keys and Runtime upload IAM to the same prefix
- `CANARY_AGENT_DATABASE_URL_SECRET_ARN`, `CANARY_KB_DATABASE_URL_SECRET_ARN`, `CANARY_OPENROUTER_API_KEY_SECRET_ARN`, `CANARY_E2B_API_KEY_SECRET_ARN`, and `CANARY_REDIS_URL_SECRET_ARN`: exact Secrets Manager ARNs. Do not put the corresponding secret values in the Runtime environment. Both database URLs require `sslmode=verify-full`.
- `RDS_CA_BUNDLE_PATH` and `NODE_EXTRA_CA_CERTS`: absolute path to the digest-pinned RDS bundle baked into the image

Optional:

- `PORT` (default `8080`)
- `LOG_LEVEL` (default `info`)
- `WORKER_HEARTBEAT_INTERVAL_MS` (default `15000`)

Runtime shutdown grace is fixed at 30 seconds and concurrency is fixed at one execution.

## Chat API

Required:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database. It is deliberately not named `DATABASE_URL`, which denotes the read-only KB credential elsewhere. It is separate from the worker's read-only `mymemo_kb` credential. The process fails at startup when it is absent. `bun run db:migrate` in `apps/chat-api` applies migrations owned by `packages/agent-db` through its exported `MIGRATIONS_DIR`.
- `STATSIG_SERVER_SECRET`: production exposure-gate secret; required unless `AGENT_EXPOSURE_BREAK_GLASS=true`
- `ARTIFACT_BUCKET`: private artifact bucket; chat-api receives read-only object access
- `AWS_REGION`: artifact S3 region
- `REDIS_URL`: authenticated `rediss://` URL. Missing, malformed, unauthenticated, or non-TLS values fail startup. Never log it.

Optional:

- `LOG_LEVEL` (default `info`)
- `PORT` (default `3000`)
- `AGENT_EXPOSURE_BREAK_GLASS` (default off): when exactly `true`, allow new work without Statsig; keep it off by default in production
- `DB_PASSWORD`: splice into a passwordless `AGENT_DATABASE_URL`
- `DB_SSL` (default on; `disable` only for local non-TLS Postgres)
- `LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS` (default off): when exactly `true`, allow unauthenticated `redis://` only for `localhost`, `127.0.0.1`, or `[::1]` in integration tests

## Agent worker

The worker owns the writable agent database, read-only KB, OpenRouter, E2B, artifact upload, and Live Stream credentials. `apps/agent-worker/src/sandbox-env.ts` must continue to pass only the Run binding into E2B.

Required:

- `AGENT_DATABASE_URL`: writable `mymemo_agent` database shared with chat-api
- `KB_DATABASE_URL`: read-only `mymemo_kb` database with a separate role and credential
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, and `OPENROUTER_DEFAULT_MODEL`: trusted-runtime model traffic
- `E2B_API_KEY`: trusted-runtime credential for the untrusted executor
- `WORKER_E2B_TEMPLATE`: custom E2B template with pinned base image and ripgrep; build and verify it with `bun run template:build` and `bun run template:verify`
- `ARTIFACT_BUCKET`: private artifact bucket; the worker receives upload access only
- `AWS_REGION`: artifact S3 region
- `REDIS_URL`: authenticated `rediss://` URL. Never log it or pass it into E2B.

Optional:

| Variable | Default | Purpose |
| --- | ---: | --- |
| `WORKER_MAX_CONCURRENT_CONVERSATIONS` | `2` | Conversation-level supervisor capacity |
| `WORKER_SANDBOX_IDLE_MS` | `300000` | E2B idle window before pause |
| `WORKER_FILE_GREP_MAX_RESULTS` | `100` | File grep result cap |
| `WORKER_FILE_GLOB_MAX_RESULTS` | `500` | File glob result cap |
| `WORKER_FILE_READ_MAX_BYTES` | `65536` | File read byte cap |
| `WORKER_BASH_TIMEOUT_MS` | `120000` | Bash timeout ceiling |
| `WORKER_BASH_MAX_OUTPUT_BYTES` | `65536` | Per-stream Bash output cap |
| `WORKER_DOCUMENT_LIST_MAX_RESULTS` | `20` | Document inventory page cap before the hard backstop of 100 |
| `WORKER_DOCUMENT_SEARCH_MAX_RESULTS` | `8` | Passage-search result cap before the query-client backstop |
| `WORKER_DOCUMENT_LOAD_MAX_DOCUMENTS` | `10` | Document ids per load call |
| `WORKER_DOCUMENT_LOAD_PER_DOCUMENT_MAX_BYTES` | `262144` | Materialized bytes per Searchable document |
| `WORKER_DOCUMENT_LOAD_PER_CALL_MAX_BYTES` | `1048576` | Materialized bytes per load call |
| `WORKER_HEARTBEAT_INTERVAL_MS` | `15000` | Ownership renewal and interruption-observation interval |
| `WORKER_SHUTDOWN_TIMEOUT_MS` | `30000` | Grace for aborting active work, terminalizing it, and releasing the Conversation before forced exit |
| `WORKER_CLEANUP_INTERVAL_MS` | `300000` | Advisory-lock-protected orphan and deleted-Conversation cleanup interval |
| `PORT` | `8080` | `/health` port |
| `LOG_LEVEL` | `info` | Log level |

`LIVE_STREAM_ALLOW_INSECURE_LOCAL_REDIS`, `DB_PASSWORD`, and `DB_SSL` have the same restrictions and behavior as chat-api.
