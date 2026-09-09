# System architecture

ADR-0035 and Spec #732 define the current system.

| Module | Responsibility |
| --- | --- |
| `apps/agent-front` | IAM Function URL, trusted identity, Scope, Statsig gate, Conversation/Turn admission, UIMessage streaming, S3 history and Workspace, Sandbox lifecycle, Cleanup sweep |
| `apps/agent-runtime` | Claude Agent SDK loop, Hand and document MCP tools, raw SDK stream, S3 transcript continuity |
| `packages/document-tools` | Scoped read-only KB queries and Docs cache materialization |
| `packages/ui-catalog` | Shared generative-UI validation and vocabulary |
| `packages/test-support` | Test helpers |

The front invokes the Runtime once per Turn, with Runtime session id = Turn
id. It passes a fresh SANDBOX Code Interpreter session id. The Runtime holds
KB/model credentials; model-driven file and shell operations run through the
Hand. The Runtime writes only the transcript. The front owns every other
durable write: one Conversation item plus Request ids in DynamoDB, whole
Turn replies in S3, Workspace tarballs and mirrored Artifacts.

Keep the Runtime security group, private subnets and fck-nat egress: the KB
Postgres remains in the shared service VPC. The Sandbox has no VPC attachment.
