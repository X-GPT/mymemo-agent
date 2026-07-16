# Downloadable artifact operations

Downloadable artifacts are durable, user-visible files deliberately written
under `/home/user/artifacts/` in a conversation workspace. The architecture and
security decisions are recorded in
[ADR-0010](../adr/0010-publish-downloadable-artifacts-on-success.md). This
runbook covers deployment, failure handling, retention, and the downstream
integration contract.

## Trusted-runtime configuration

Both `chat-api` and `agent-worker` require:

- `ARTIFACT_BUCKET`: the private S3 bucket provisioned for the environment;
- `AWS_REGION`: the region containing that bucket.

The AWS SDK uses each ECS task role through its default credential provider
chain. Do not configure long-lived AWS credentials. `agent-worker` may upload
and delete objects, while `chat-api` may read the one current object selected by
an ownership-checked Postgres record so it can sign a download. Neither role may
list the bucket. The migration task receives neither artifact configuration nor
artifact S3 permissions.

Artifact bucket configuration, AWS credentials, and presigned URLs stay inside
the trusted Fargate runtimes. None are passed to E2B. The sandbox receives only
the per-Run binding produced by `buildSandboxEnv`.

Terraform owns the bucket and enforces Block Public Access,
bucket-owner-enforced ownership, TLS-only access, SSE-S3 (`AES256`) encryption,
disabled versioning, and no CORS policy or customer-managed KMS key. Its only
lifecycle rule aborts incomplete multipart uploads; it does not expire current
artifacts.

## Publication and quotas

The worker captures the reserved tree at Run start and publishes only files
whose size or modification timestamp changed during a successful Run. Files
outside `/home/user/artifacts/`, including scratch files and `.mymemo/docs/`,
are not Downloadable artifacts.

Publication is all-or-nothing. Object keys are ledgered before upload, and all
changed metadata becomes current in the same fenced Postgres transaction that
appends `run_done`. The existing `done` SSE frame is therefore the refresh
signal; there is no artifact-specific Run event or SSE frame.

The post-upsert current set is limited to:

- 100 MiB per artifact;
- 100 current artifact paths per conversation;
- 1 GiB total current artifact bytes per conversation.

Validation, quota, upload, ownership, cancellation, or persistence failure
leaves the prior current set unchanged. A Run with an `error` Outcome exposes
only the generic `Run failed` message to the client. Internal structured
diagnostics identify a bounded failure category or stage without object bodies,
presigned URLs, or provider error details.

## Download and retention behavior

`GET /v1/conversations/:conversationId/artifacts` reads the authoritative
current set from Postgres. The response is path-sorted and contains only
`artifactId`, `path`, `sizeBytes`, `contentType`, `createdAt`, and `updatedAt`.

`GET /v1/conversations/:conversationId/artifacts/:artifactId` reauthorizes the
conversation owner and returns a fresh `302` to S3. The presigned URL expires
after five minutes and forces `Content-Disposition: attachment`; generated
HTML, images, scripts, PDFs, and archives are never rendered inline by this
contract. V1 does not malware-scan outputs, so clients must label and handle
them as untrusted generated files.

Overwriting one path preserves its stable `artifactId` and immediately makes
only the new object current. The superseded object is retained for ten minutes
before cleanup eligibility so a five-minute URL issued just before the swap can
finish. This grace is storage lifecycle state, not user-visible version history.

Current artifacts live for the conversation lifetime and have no age-based
expiry. Conversation deletion immediately removes list/download access and
makes all of its ledgered objects cleanup candidates. A URL issued before
deletion cannot be revoked and may remain usable until its five-minute expiry.

## Diagnose publication failures

1. Confirm the Run outcome and artifact lifecycle counts without selecting Run
   payloads or object keys:

   ```sql
   SELECT status, count(*)
   FROM runs
   WHERE updated_at >= now() - interval '15 minutes'
   GROUP BY status;

   SELECT status, count(*)
   FROM artifact_objects
   GROUP BY status;
   ```

2. Search worker logs for the bounded `artifactFailure` fields. `validation`
   indicates an unsafe path or tree entry; `quota` names the exceeded bound;
   `publication` names `manifest`, `ledger`, `read`, or `upload`.
3. For upload failures, verify worker task-role access and bucket/region
   injection. Do not copy credentials or a presigned URL into the sandbox for
   diagnosis.
4. Confirm that an errored or canceled Run did not change the list endpoint.
   Staged objects may remain in the ledger; that is expected until cleanup.

## Diagnose cleanup failures

The worker runs one advisory-lock-protected cleanup pass at
`WORKER_CLEANUP_INTERVAL_MS` (five minutes by default). It never lists S3 and
never deletes an object still referenced by current metadata. Pending objects
from active Runs are skipped. Failed deletion retains the ledger row and is
retried on a later pass; one failed object does not stop other candidates.

If pending or superseded counts keep growing:

1. confirm at least one worker is healthy and cleanup passes continue;
2. inspect the cleanup summary and bounded warning counts;
3. verify the worker task role still has object-scoped `s3:DeleteObject` and no
   bucket-list permission; and
4. leave ledger rows intact so the next pass can retry safely.

Do not add an S3 age-expiration rule as a cleanup shortcut. It could delete a
live conversation's current object behind Postgres.

## Deployment order

Run the agent database migrations before rolling either ECS service. The
release workflow registers infrastructure/task definitions, runs
`scripts/deploy/run_agent_migration.sh`, then updates the services through
`scripts/deploy/roll_ecs_services.sh`. This ordering is required because the
worker publication and API retrieval paths depend on the artifact metadata and
lifecycle tables.

After deployment, verify that both services boot with `ARTIFACT_BUCKET` and
`AWS_REGION`, then exercise one Run that writes a small file and confirm `done`,
list, and attachment redirect behavior. Never follow or log the presigned URL
as part of automated diagnostics.

## Downstream integration contract

`mymemo-service` authenticates the web request, forwards the trusted
`X-Member-*` and `X-Partner-*` identity headers, relays the list response
unchanged, and relays the download `302` plus `Location` without following the
redirect. It must not proxy object bytes, persist artifact metadata, sign URLs,
or receive artifact-bucket permissions.

`mymemo-web` refreshes the list after the existing `done` frame. It starts a
download through a link or other normal browser navigation so the browser
follows the redirect directly to S3. It must not fetch the object as a
JavaScript blob or require bucket CORS, and it should present every item as an
untrusted generated file.

The downstream service and web changes live in their own repositories; no
`mymemo-service` or `mymemo-web` implementation belongs in this repository.
