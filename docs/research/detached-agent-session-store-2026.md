# Shared Storage for Detached Agent Sessions

**Research date:** 2026-08-26. This note resolves [Find a shared store for detached Agent sessions](https://github.com/X-GPT/mymemo-agent/issues/581). External claims come only from first-party AWS and PostgreSQL documentation. Repository claims come from the current `main` source and read-only AWS control-plane inspection on the research date.

## Recommendation

Store one opaque serialized detached-session object per Conversation in the existing private S3 bucket, under a new Runtime-only prefix such as `agent-sessions/<conversationId>`. Each invocation performs one `GetObject` before creating the in-memory Agent session and one unconditional `PutObject` after `detach()`; the Runtime then purges its in-memory store.

This is the smallest option that satisfies all settled semantics:

- Any `agent-query-runtime` instance can address the same object through its AgentCore execution role.
- S3 `PUT` overwrites are strongly read-after-write consistent, and a single-key update is atomic: a reader receives either the complete old object or the complete new object, never a partial value. For concurrent unconditional writes, S3 applies internal last-writer-wins semantics based on the requests' S3 timestamps; request arrival and acknowledgement order are not predictable, so the final value is determined by reading after both writes are acknowledged. No application CAS, branch, merge, or winner policy is needed for the settled load-whatever-is-present behavior ([S3 consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)).
- A single `PUT` supports 5 GB, so a provisional 100 MB or 100 MiB ceiling fits without multipart upload ([S3 upload options](https://docs.aws.amazon.com/AmazonS3/latest/userguide/upload-objects.html)).
- S3 stores the serialized bytes rather than interpreting JSON, so it preserves Claude's detached state byte-for-byte.
- The bucket already blocks public access, enforces bucket ownership, encrypts with SSE-S3, denies non-TLS transport, does not enable versioning, and has no lifecycle deletion rule for completed objects ([bucket Terraform](../../infra/terraform/artifacts.tf)). Existing chat-api and maintenance permissions are limited to `objects/*`, so an `agent-sessions/*` prefix is not reachable through artifact listing, signing, or cleanup ([service IAM](../../infra/terraform/iam.tf)).

Do not create a new storage abstraction or bucket for this slice. The one S3 object is the state store.

## Current deployment facts

The repository deploys `agent-query-runtime` in AgentCore `PUBLIC` network mode. Its role can pull its image, read only the OpenRouter secret, write logs and metrics, and invoke no user-delegated Runtime operation. Its environment contains only AWS Region, OpenRouter configuration, and port; it has no database, Valkey, S3, or AgentCore Memory configuration ([Runtime Terraform](../../infra/terraform/agentcore-runtime.tf), [query Runtime IAM](../../infra/terraform/agentcore-iam.tf), [query Runtime environment](../../infra/terraform/agentcore-locals.tf)). Its package has the Secrets Manager SDK but no S3, PostgreSQL, or Redis client ([package manifest](../../apps/agent-query-runtime/package.json)).

Read-only AWS API inspection confirmed on 2026-08-26:

| Surface | Deployed state |
| --- | --- |
| Agent-query Runtime | Version 3, `READY`, `PUBLIC`, no `filesystemConfigurations`, only OpenRouter and basic Runtime environment variables |
| AgentCore Memory | No Memory resource exists in `us-west-2` |
| RDS PostgreSQL | PostgreSQL 17.9, `db.t4g.micro`, 20 GB allocated with 100 GB autoscaling maximum, private, single-AZ, seven-day backup retention |
| ElastiCache | Valkey 7.2.6, one `cache.t4g.micro` node, failover and Multi-AZ disabled, snapshot retention zero, TLS and at-rest encryption enabled |
| S3 | Existing `mymemo-agent-prod-artifacts` bucket, SSE-S3 enabled, versioning not enabled |

These facts were obtained with the official AWS CLI operations `GetAgentRuntime`, `ListMemories`, `DescribeDBInstances`, `DescribeReplicationGroups`, `DescribeCacheClusters`, `GetBucketEncryption`, and `GetBucketVersioning` under the repository-mandated `mymemo` profile. No secret values or stored content were read.

## Candidate comparison

| Candidate | 100 MB state | Read/overwrite semantics | Current access from query Runtime | Minimum expansion | Verdict |
| --- | --- | --- | --- | --- | --- |
| Existing S3 bucket | Yes; 5 GB single `PUT` | Strong read-after-write; atomic complete-object replacement; concurrent writes use S3's internal last-writer-wins order | Public AWS endpoint is reachable; role lacks object permission | Runtime S3 code/dependency plus a bucket env value and prefix-scoped IAM | **Use** |
| Existing RDS PostgreSQL | Yes; PostgreSQL field limit is 1 GB | Transactional one-row upsert and committed reads | No: RDS is private; Runtime is public and has no URL, password-secret permission, CA bundle, driver, schema, or network path | Shared database package, schema/migration/tests, Runtime DB bootstrap, secret/IAM, CA image work, and VPC networking | Viable but needlessly broad |
| Existing ElastiCache Valkey | Protocol yes; one element may be 512 MiB | Primary `SET`/`GET` is simple, but deployed data is cache-only and disappears on node failure | No: cache is private; Runtime is public and lacks its secret, client, and security group | Runtime Redis code/dependency plus VPC networking, SG, secret IAM/config; durable use would additionally require replacing/upgrading the cache | Reject |
| AgentCore managed session storage (Preview) | Yes; 1 GB per Runtime session | Standard filesystem locally; replication is asynchronous and AWS documents no concurrent same-file overwrite ordering | Not configured; no extra IAM or VPC required | One Runtime filesystem configuration plus file I/O and deployed verification | Reject as Conversation truth: wiped after 14 idle days and every Runtime version update |
| AgentCore Memory | No; one event is limited to 10 MB | Append/list/delete events, not one unconditional latest-value object | No Memory resource or IAM exists | New Memory resource, IAM/config, SDK code, and multi-event framing/replacement | Reject |

### Existing S3 bucket

S3 matches the deliberately simple concurrency semantics. `GetObject` loads whatever complete value is present. `PutObject` replaces the object unconditionally. S3 explicitly documents strong consistency for overwrites and atomic updates to one key. For simultaneous writes it uses internal last-writer-wins semantics, but network latency makes request arrival and acknowledgement order unpredictable; a read after all writes are acknowledged reveals the retained value ([consistency model](https://docs.aws.amazon.com/AmazonS3/latest/userguide/Welcome.html#ConsistencyModel)). Versioning is not enabled in this repository, so an overwrite does not create an application-visible history ([bucket Terraform](../../infra/terraform/artifacts.tf)).

The query Runtime's public network mode already reaches AWS public service endpoints. AgentCore supplies execution-role credentials, so no new secret is required. IAM can be limited to `s3:GetObject` and `s3:PutObject` on `${aws_s3_bucket.artifacts.arn}/agent-sessions/*`; neither bucket listing nor delete permission is needed for the first slice. The bucket name is a non-secret environment value.

### Existing RDS PostgreSQL

PostgreSQL permits a 1 GB field and moves oversized variable-length fields out of the main tuple through TOAST, so a 100 MB `bytea` is legal ([PostgreSQL limits](https://www.postgresql.org/docs/current/limits.html), [TOAST](https://www.postgresql.org/docs/current/storage-toast.html)). Transactions make the upsert atomic and durable, and Read Committed never exposes uncommitted data ([transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html), [transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)). A `bytea` column, rather than `jsonb`, would preserve the serialized representation exactly.

The service is nevertheless a poor fit for the requested narrow slice. `packages/agent-db` owns all writable schema and migrations ([database guidance](../agents/database.md)); an application-local table would violate that ownership. The Runtime would also need private VPC mode, database security-group access, the passwordless URL plus password-secret permission, verified TLS and the RDS CA bundle, `pg`/Drizzle dependencies, database bootstrap, and shared-package tests. The current query image is Alpine and does not contain the production Runtime's pinned RDS bundle ([query Dockerfile](../../apps/agent-query-runtime/Dockerfile), [production Runtime Dockerfile](../../apps/agentcore-runtime/Dockerfile)).

The deployed database is also single-AZ. RDS Multi-AZ synchronously replicates to a standby, but this instance is not configured that way ([RDS Multi-AZ](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Concepts.MultiAZSingleStandby.html)). Its 100 GB autoscaling ceiling would hold only roughly one thousand maximum-size session values before indexes, TOAST overhead, or any existing application state.

### Existing ElastiCache Valkey

ElastiCache allows a single element request up to 512 MiB, so the protocol can carry 100 MB ([Valkey and Redis OSS limits](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/RedisConfiguration.html)). The deployed `cache.t4g.micro` has only 0.5 GiB of memory ([supported node types](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/CacheNodes.SupportedTypes.html)); one maximum-size state consumes about one fifth of raw node memory before allocator and existing relay overhead.

More importantly, the deployed cache is one node with no snapshots. AWS states that a failed single-node Valkey/Redis OSS cluster loses all data ([replication groups](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Replication.html)). Under `volatile-lru`, only keys with expiry are eligible for eviction; because this slice deliberately adds no retention, session keys would instead accumulate until writes fail with an out-of-memory error ([Valkey and Redis OSS configuration](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/RedisConfiguration.html)). Valkey 9 durability can persist synchronous writes in a Multi-AZ log, but the deployed engine is 7.2.6 and has no durability configuration ([durability options](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/Durability.Options.html)). Turning the live pub/sub relay into durable session storage would therefore be a cache replacement project, not reuse.

### AgentCore-native storage

Managed session storage is the closest prototype-only alternative. AgentCore mounts a service-managed filesystem per `runtimeSessionId`, needs no VPC or extra IAM, supports ordinary file operations, and permits 1 GB per session. Data is asynchronously replicated and restored when the same Runtime session resumes ([filesystem configuration](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/runtime-filesystem-configurations.html), [AgentCore quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html)).

It is not durable Conversation storage: AWS labels it Preview and resets it after 14 days without invocation and after every Runtime version update. AWS recommends waiting for `StopRuntimeSession` before resume to guarantee that data has flushed, and does not specify atomic last-write behavior for overlapping Runtime instances. The deployed Runtime has no filesystem configuration. It may remain useful for a throwaway deployed prototype, but accepting routine release-driven loss would bake a known invalid ceiling into the first implementation.

AgentCore Memory is not a latest-value blob store. It exposes event creation/listing/deletion and accepts binary event payloads, but one event is capped at 10 MB, one message at 100 KB, and event expiry must be between 7 and 365 days ([Memory quotas](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/bedrock-agentcore-limits.html), [CreateEvent](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_CreateEvent.html), [PayloadType](https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_PayloadType.html)). Splitting one opaque state across events and deleting/reassembling it would add a protocol and still miss the provisional 100 MB one-value requirement. No Memory resource exists in the deployed account.

## Minimum S3 implementation surface

The happy path needs only:

1. In `apps/agent-query-runtime`, add the already-used workspace dependency `@aws-sdk/client-s3` and a small store with `load(conversationId)` and `overwrite(conversationId, bytes)`. Treat `NoSuchKey` as no state; reject a serialized state over the chosen explicit byte ceiling before upload.
2. In the invocation flow, load before hydrating the invocation-local in-memory Claude store; after the stream is fully consumed, call `detach()`, serialize once, `PutObject`, then clear the in-memory store. Do not expose session state in the response.
3. In Terraform, pass the existing bucket name to the query Runtime and grant its execution role only `s3:GetObject` and `s3:PutObject` on `agent-sessions/*`.
4. Add one Runtime test that proves absent load, exact byte round-trip, unconditional replacement, and purge-after-detach. Validate Terraform and verify one deployed two-turn conversation across distinct Runtime instance markers.

No chat-api code, shared package, database schema, migration, bucket, secret, VPC, security-group, retention rule, delete path, CAS, or multipart upload is required.

## Scope answer

The **functional TypeScript scope holds**: session behavior can live entirely in `apps/agent-query-runtime`; `apps/chat-api/src/features/ai-chat/` does not need to know that detached state exists.

The **literal file scope does not hold**. A production-capable implementation must also change `infra/terraform/agentcore-locals.tf` and `infra/terraform/agentcore-iam.tf`, plus the Runtime package manifest and likely the root `bun.lock`. Those are deployment wiring, not a new application/storage subsystem. S3 is the only durable candidate that avoids expanding into `packages/agent-db`, migrations, shared Redis code, or Chat API persistence.

Retention, cancellation, retries, process-death recovery, Workspace behavior, conditional writes, branches, merge semantics, and winner selection remain explicitly out of scope.
