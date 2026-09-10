# Security boundaries

Only trusted callers invoke the AWS_IAM Function URL. Parse forwarded identity
at the front boundary and check Conversation ownership on every route.
The exposure gate runs on creation and send. In `statsig` mode it fails
closed; in `open` mode (production since the 2026-09-10 Agent Beta launch,
ADR-0035 amendment) every forwarded identity passes because admission moved to
mymemo-service, which refuses unfunded Turns before signing the relay call.
Never expose a switch to bypass identity; the gate mode is Terraform-only.

The Runtime holds KB and OpenRouter credentials, resolved from AWSCURRENT
secret ARNs. KB URLs require `sslmode=verify-full` and the pinned RDS CA.
The front holds Statsig and its scoped AWS grants; it owns DynamoDB, history,
Workspace and Artifact access. The Runtime S3 grant covers transcripts only.

Model-authored HTML artifacts are untrusted pages. The `…/artifacts/:id/content`
route serves them as `text/plain` with `nosniff` to the owner only, so they are
never a document on our origin; `mymemo-web` renders them solely in an
opaque-origin `srcdoc` sandbox under a `default-src 'none'` CSP whose only
script source is the vendored `/agent-libs/` directory (ADR-0036). Never relax
that sandbox, add `allow-same-origin`, widen the CSP to a CDN, or render the
bytes outside the frame. Downloads stay forced-attachment (ADR-0011).

The Code Interpreter Sandbox runs prompt-injectable code and contains no
credentials. Route file/shell tools through the Hand, validate paths and caps,
and never widen document Scope. Anonymous regional S3 reachability is the
accepted ADR-0035 residual; do not add credentials or VPC access to the Hand.
