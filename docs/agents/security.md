# Security boundaries

Only trusted callers invoke the AWS_IAM Function URL. Parse forwarded identity
at the front boundary and check Conversation ownership on every route.
The Statsig gate fails closed on creation and send. Never expose a production
switch to bypass identity or the gate.

The Runtime holds KB and OpenRouter credentials, resolved from AWSCURRENT
secret ARNs. KB URLs require `sslmode=verify-full` and the pinned RDS CA.
The front holds Statsig and its scoped AWS grants; it owns DynamoDB, history,
Workspace and Artifact access. The Runtime S3 grant covers transcripts only.

The Code Interpreter Sandbox runs prompt-injectable code and contains no
credentials. Route file/shell tools through the Hand, validate paths and caps,
and never widen document Scope. Anonymous regional S3 reachability is the
accepted ADR-0035 residual; do not add credentials or VPC access to the Hand.
