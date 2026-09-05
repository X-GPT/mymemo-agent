# Serve chat through a Lambda front, the AgentCore Runtime and a Code Interpreter hand over DynamoDB and S3

Status: accepted (2026-09-05). Supersedes
[ADR-0034](0034-run-the-chat-loop-in-per-conversation-lambda-microvms.md) (the
`/v2` MicroVM design, deleted before it served production) and, with it, every
decision whose subject retires at cutover: ADR-0005, 0007, 0008, 0009, 0012,
0013, 0014, 0015, 0016, 0020, 0022, 0023, 0025, 0026, 0027, 0030, 0031 and
0033. Amends [ADR-0011](0011-publish-downloadable-artifacts-on-success.md) and
[ADR-0017](0017-emit-display-only-generative-ui-as-catalog-payloads.md) (below).
Keeps ADR-0032 (fck-nat egress). Decided on
[wayfinder map #719](https://github.com/X-GPT/mymemo-agent/issues/719); the
buildable contract is [Spec #732](https://github.com/X-GPT/mymemo-agent/issues/732).

MyMemo chat is served by a **Lambda front** that owns identity, Scope, the
exposure gate, the DynamoDB record and single flight, invokes the **AgentCore
Runtime** with streaming and relays the **AI SDK UIMessage stream**. The
Runtime hosts the Claude Agent SDK loop with **every file tool and Bash routed
to a custom AgentCore Code Interpreter** — the *hand* — over a
**per-Conversation Amazon S3 Files access point** mounted at `/mnt/ws`; the
transcript lives in the SDK's **S3 SessionStore**. State is one DynamoDB table
and two S3 prefixes. There is no queue, no outbox, no ownership fencing, no
reclaimer, no Redis, no agent Postgres, no E2B, no MicroVM.

## Why simplify

The system had grown three ways at once: v1 in production (AgentCore + E2B +
transactional outbox + ownership epochs + maintenance reclaimer + Redis relay +
Postgres), a charted v3 (six deployables, DynamoDB + SQS + three Lambdas + a
MicroVM hand), and a repository carrying v2 residue and three stale maps. Most
of that machinery existed to compensate for boundaries it had to build itself:
serialising Turns across replicas, recovering crashed workers, relaying a
stream between processes, brokering credentials into an untrusted VM. The
decision here is to buy those boundaries from managed services and delete the
compensation.

## The trust stance

- **The Code Interpreter is the untrusted hand; the Runtime holds every
  credential.** The model's tool calls execute in a sandbox that carries no
  credential, has no network route (no NAT, no S3 endpoint — DNS resolves,
  TCP goes nowhere) and sees exactly one mounted access point. The Runtime
  invokes it with SigV4 under its own execution role; nothing is minted,
  brokered or injected. ADR-0001's split runtime and ADR-0034's in-VM process
  boundary are both retired: the tenant boundary is the sandbox microVM and
  the credential boundary is the AWS API between the Runtime and the hand.
- **One S3 Files access point per Conversation is the isolation boundary.**
  A shared access point with hand-side path confinement was rejected because
  `bash` cannot be confined by the hand. The transcript prefix lies outside
  every access-point root, so no sandbox can read any Conversation's memory.
- **The front trusts nothing it did not verify itself and the Runtime trusts
  the front completely**: mymemo-service reaches the front over IAM + SigV4
  with the identity headers; the front is the Runtime's only caller (IAM);
  the invoke payload is authoritative.

## The no-queue, no-resume, no-interrupt stance

- **Single flight is one conditional write.** The Conversation item carries
  `processing { turnId, until }`; a second `send` while it is set and fresh
  gets **409** and the client resends after the stream ends. A stale
  `processing` (past `until`) is healed by the next `send`, which marks the
  old Turn `abandoned`. There is no reclaimer, no lease, no fencing token.
- **A Turn is at most once and ends only in the Runtime.** The front cannot
  cancel the Runtime; when the front's stream dies the Runtime finishes the
  Turn anyway — history, artifacts and the terminal write all land. A client
  that lost its stream reloads history; nothing re-attaches mid-Turn.
- **Interrupt is cut.** ADR-0013's interruption story dies with the Run path;
  the 10-minute Turn budget (enforced by the Runtime) is the only way a Turn
  ends early.
- **History is DynamoDB, written incrementally by the Runtime**; text deltas
  exist only on the stream. The transcript (the model's memory) is a separate
  concern, mirrored to S3 by the SDK, and its `mirror_error` is logged and
  otherwise ignored — an accepted loss of that batch's lines, never of
  history.

## DynamoDB over Postgres

The agent Postgres served as the Run event log, the outbox, the ownership
ledger, the SessionStore and the artifact ledger. Every one of those roles is
gone or moved: the Turn record and its Steps are items in one
Conversation-partitioned table; idempotency is a `REQ#` item; artifacts are
`ART#` items mirrored from the mount; the transcript is S3. What remains is a
key-value workload with one conditional transaction per `send`, which is what
DynamoDB is for. Nothing ages out (no TTL — the user's decision that nothing
is ever expired automatically); deletion is a tombstone plus a five-minute
cleanup sweep that retries until the workspace versions, the transcript, the
access point and the items are gone.

## Considered options

- **Keep v1 (AgentCore + E2B + outbox + Postgres + Redis).** Rejected: the
  dispatch, ownership and maintenance machinery exists to serialise and
  recover work that a single conditional write and a Runtime that always
  finishes its Turn make unnecessary.
- **The charted v3 (DynamoDB + SQS FIFO + Fargate Runner pool + MicroVM
  hand).** Rejected: six deployables to do what a Lambda and the Runtime do
  directly; the queue only existed because the front could not invoke the
  Runtime with streaming.
- **Lambda MicroVMs (ADR-0034).** Deleted before serving production: the VM
  had no shell (bubblewrap cannot mount `/proc`), no path to S3, and needed a
  credential gateway plus checkpoint brokering — all compensation for a
  boundary the Code Interpreter provides natively.
- **E2B as the hand.** Rejected: a third vendor with its own credential and
  copy-in/copy-out; the Code Interpreter mounts S3 Files directly, so the
  workspace is one S3-backed place with no sync code.
- **Built-in file tools on the Runtime disk.** Rejected: the Runtime disk is
  ephemeral and the tools would run with the Runtime's credentials.
- **A PUBLIC-mode Runtime (no VPC, no NAT).** Parked, not rejected: it needs
  the document tools to read the knowledge base through mymemo-service's API
  instead of the VPC-private Postgres.
- **Chat-api on ECS as the front.** Rejected: a Lambda behind a Function URL
  streams, needs no ALB, no task role for the DB, and no rolling deploy.

## Measured facts this decision rests on

From the real-topology probe ([#730](https://github.com/X-GPT/mymemo-agent/issues/730)):
S3 Files exists in us-west-2 with mount targets in the Runtime's zones; a
VPC-mode Code Interpreter starts a session with the mount in ~2.7 s (17 s for
the first session on a fresh interpreter) and answers calls in 95–170 ms; the
sandbox has no egress; files written appear in the bucket ~66 s after write
inactivity and persist across sessions; the file APIs accept relative paths
only, so the hand symlinks `ws → /mnt/ws` in the sandbox workdir; a stopped
session raises `ValidationException … not active`; `CreateCodeInterpreter`
validates the execution role and needs the S3 Files read set beyond the
documented three actions. From the SDK probe: a pre-minted `sessionId` with a
`sessionStore` resumes on a fresh config dir on the pinned 0.3.251, with no
duplicate entries, provided `cwd` is fixed. The prod private subnets reach the
AgentCore data plane through fck-nat.

## Consequences

- **Language.** *Conversation* and *Turn* stay; *Run* dies with v1; v2's
  In-VM server, Nudge, Live Stream, Checkpoint, Interruption and Recovering
  leave the glossary; *Lambda front*, *Hand*, *Sandbox session*, *Turn
  budget*, *Tombstone* and *Cleanup sweep* enter it. `CONTEXT.md` carries the
  surgery in this PR.
- **The wire.** The client speaks the AI SDK UIMessage stream; the generative
  UI catalog rides it as `data-generative-ui` parts (renamed from the AG-UI
  `CUSTOM mymemo.generative_ui` event — see the ADR-0017 amendment) and
  artifacts as `data-artifacts` parts. mymemo-web rebuilds onto `useChat`
  (out of this effort's scope beyond the compatibility prototype).
- **Deletion timing.** v1 serves production until cutover; the spec's ledger
  names every component's fate. Deleted now: the whole v2 stack (PR #729)
  and the sandboxed-HTML origin (PR #731).
- **Operations.** New alarms replace v1's set: Turn error rate by code, budget
  exhaustion, `mirror_error`, cleanup backlog age, sandbox start failures,
  front 5xx. Quotas to watch: 1,000 concurrent sandbox sessions, 30 TPS on
  the sandbox APIs, 25,000 access points per file system.
- **Cost.** A Turn costs its sandbox seconds; an idle Conversation costs its
  S3 Files storage; fck-nat stays (~$13/month) because the Runtime remains in
  the VPC for the knowledge base.

## Amendment to ADR-0011 — the mounted workspace is the artifact store

The `artifacts/` subtree of the Conversation's mount **is** the store; there
is no publish copy and no `artifact_objects` ledger. Survives: one current
entry per path, a stable opaque `artifactId` (path hash) across overwrites,
DynamoDB as the only listing source, five-minute presigned `GetObject` with
forced `Content-Disposition: attachment`, extension-derived content type, the
100 MiB per-file cap, ownership-gated 404s, artifacts living as long as their
Conversation. Dies: run-scoped object keys, all-or-nothing publication, the
success-only rule (`data-artifacts` is emitted on `done` and `error`), the
Turn-start manifest, the superseded-object grace, disabled versioning (S3
Files requires it), the 100-path and 1 GiB per-Conversation caps. Changes:
**upsert-only becomes mirror semantics** — a path absent from `artifacts/`
at Turn end deletes its listing; and a download can return `409
not_exported_yet` inside the export lag.

## Amendment to ADR-0017 — the catalog rides the UIMessage stream

The catalog, its five components, its caps and its validate → persist → emit
rule are unchanged. The wire form is a `data-generative-ui` part with a
stable MyMemo-issued id, persisted into the Turn's Step item before the chunk
is sent, instead of the AG-UI `CUSTOM mymemo.generative_ui` event. History
re-serves the same part.
