# Publish downloadable artifacts atomically on successful runs

Status: accepted

A workspace contains private scratch files, reconstructible knowledge-base
content, and user-facing outputs, and its files may be written by either the
text file tools or Bash. Only files deliberately placed in a reserved
`artifacts/` subtree are downloadable artifacts. After agent execution
completes successfully, the worker publishes the subtree's files created or
changed by that run to durable object storage and persists their metadata before
terminalizing the run as `done`; running, errored, and interrupted runs publish
nothing. This trades away recovery of incomplete outputs so clients never list
partial files and a `done` outcome means every artifact change detected for that
run is durable and downloadable.

No new model-facing publish tool is added. The static system prompt tells the
agent to place user-requested downloadable outputs under
`/home/user/artifacts/`, keep scratch work elsewhere, and use the existing
`Write`, `Edit`, or `Bash` tools as appropriate. Publication is therefore a
successful-run boundary over the reserved tree, not an extra tool call the
model can forget.

Artifact manifesting and upload remain inside the supervised run lifecycle,
while sandbox renewal and ownership heartbeats are active. Run interruption
keeps its existing priority until the terminal-success transaction commits: it aborts
in-progress uploads, leaves current artifact metadata unchanged, terminalizes
the run as `interrupted`, and leaves any uploaded object keys for ledger-driven
cleanup.

An artifact is the conversation's current file at one normalized relative path,
not an immutable version. Publishing the same path on a later successful run
atomically replaces its object and metadata, so listings contain one entry per
path and any prior download reference resolves to the latest published contents.
Publication is upsert-only: paths present in `artifacts/` are created or
replaced, but an absent path never deletes a previously published artifact. The
workspace is best-effort under ADR-0007, so treating absence as deletion could
erase durable downloads merely because a sandbox was lost. Artifact deletion,
if introduced, requires an explicit user-visible operation.

Publishing one run is all-or-nothing. The worker uploads candidate files to
opaque, run-scoped S3 object keys first. After every upload succeeds, the same
Postgres transaction replaces the affected path-to-object metadata and
terminalizes the run as `done`; the object keys then become committed without
an S3 rename. An upload failure is retried within the owned run, but exhaustion
leaves all prior metadata in place and terminalizes the run as `error`.
Superseded and never-committed objects are deleted asynchronously. These
internal objects provide atomic replacement and are not user-visible artifact
versions.

Postgres is the metadata source of truth; the API never derives a listing from
S3. `conversation_artifacts` holds one current record per
`(userId, conversationId, path)`, with a stable `artifactId`, current object key,
size, content type, and timestamps. A separate internal `artifact_objects`
ledger records every intended S3 key before upload and retains it until the key
is either referenced by a current artifact or successfully deleted. This lets
cleanup recover pending and superseded objects after a worker crash without
creating user-visible version history.

The artifact bucket is private and the two trusted runtimes use separate ECS
task roles. `agent-worker` may upload and asynchronously delete artifact objects;
`chat-api` may read only the object named by an ownership-checked Postgres
artifact record. Neither runtime needs bucket-wide listing, and S3 credentials
or presigned access are never placed in the untrusted sandbox.

Terraform provisions a dedicated artifact bucket per environment with S3 Block
Public Access, bucket-owner-enforced object ownership, explicit SSE-S3
(`AES256`) default encryption, and a bucket policy denying non-TLS requests.
S3 versioning is disabled to match the current-file product model; a
customer-managed KMS key is not required for v1.

Downloads do not proxy object bytes through `chat-api` or `mymemo-service`.
After the internal request passes the same conversation-ownership gate as the
rest of the API, `chat-api` returns `{ downloadUrl }` containing a presigned S3
`GetObject` URL for that one artifact. A listing never contains a reusable
download URL; every download request reauthorizes ownership and creates a fresh
URL. Each presigned URL expires after five minutes.

`mymemo-service` remains a thin authenticated adapter: it forwards the trusted
identity headers, relays the list response unchanged, and consumes the returned
`downloadUrl`. With same-origin session-cookie authentication it may turn that
URL into a browser-facing redirect; with bearer-header authentication it returns
the URL as JSON so `mymemo-web` can fetch it while authenticated and then
navigate to it. It does not duplicate artifact metadata, receive S3 permissions,
sign URLs, or proxy object bytes. Neither browser flow fetches the artifact as a
blob, so the private bucket needs no CORS policy.

The HTTP resource uses a stable opaque `artifactId`. The list endpoint returns
that id, and the download endpoint addresses
`/v1/conversations/:conversationId/artifacts/:artifactId/download-url`; overwriting the
artifact at a path retains its id. The path remains user-visible metadata and
the conversation-scoped uniqueness key, but it is not embedded in a route.

V1 enforces a 100 MiB maximum per artifact, at most 100 current artifact paths
per conversation, and at most 1 GiB of current artifact bytes per conversation.
The worker evaluates the post-upsert current set before committing metadata;
exceeding any limit fails the publication atomically and the run ends `error`.
Replacing an artifact consumes only the new current size because superseded
objects are not user-visible versions and are cleanup candidates.

The artifact tree may contain nested directories, but only regular files whose
fully resolved paths remain inside the reserved subtree are publishable. Any
symlink, socket, device, or other special entry fails publication rather than
being followed or silently skipped, so `done` still means the entire eligible
tree was published.

The worker captures a manifest of artifact relative path, byte size, and
modification timestamp at run start, then compares it with the successful final
tree. Only new or changed tuples are publication candidates; unchanged files
are not re-uploaded, missing paths do not delete, and leftovers from a failed
run are not accidentally published by a later unrelated run. This intentionally
uses rsync-style metadata rather than content hashes for speed: a same-size file
whose timestamp is preserved or reset by Bash is not detected in v1.

An artifact path is a case-sensitive, normalized POSIX path relative to the
reserved tree, preserving nested directories and bounded to 1,024 UTF-8 bytes.
Empty paths, dot/traversal segments, NUL or control characters, invalid UTF-8,
and any path resolving outside the artifact root are invalid. An invalid
candidate fails the publication atomically rather than being omitted.

`GET /v1/conversations/:conversationId/artifacts` returns the complete current
set, sorted lexicographically by `path`; the 100-artifact limit makes pagination
unnecessary in v1. Each entry contains only `artifactId`, `path`, `sizeBytes`,
`contentType`, `createdAt`, and `updatedAt`. S3 keys, checksums, internal run ids,
and presigned URLs are not list metadata.

No artifact-specific SSE frame is added. Artifact metadata changes and
`run_done` are committed in the same Postgres transaction, so after
`mymemo-web` receives `done` it refreshes the list endpoint and observes the
authoritative current set. An errored or interrupted run emits no refresh promise.

List and download requests parse the trusted identity headers and authorize the
conversation owner before looking up artifacts. A missing or foreign
conversation or artifact returns `404`, preserving the existing non-disclosure
contract. These endpoints do not consult the Statsig exposure gate: retrieving
existing data is not admission of new agent work.

Every presigned response forces `Content-Disposition: attachment` with a
sanitized UTF-8 basename derived from the artifact path. The worker records a
trusted extension-based `contentType`, falling back to
`application/octet-stream`; content type never permits inline rendering, even
for PDFs, images, HTML, or scripts.

V1 does not malware-scan artifacts. They are private outputs available only to
the owning user and are always forced downloads, but remain untrusted generated
files; `mymemo-web` must present them as such. Malware scanning is not part of
the run-success path.

Current artifacts have the same lifetime as their conversation and do not
expire by age. Conversation deletion removes artifact metadata from list and
download access immediately; the worker's durable cleanup ledger then drives
idempotent deletion of current objects. The same ledger retains abandoned
pending and superseded objects until S3 deletion succeeds. A superseded object
is not cleanup-eligible for ten minutes, so a five-minute presigned URL issued
just before an overwrite remains usable; this grace is not exposed as version
history. A URL issued just before conversation deletion likewise remains usable
for at most its five-minute lifetime; immediate revocation is deliberately not
added to the direct-S3 v1 design.
