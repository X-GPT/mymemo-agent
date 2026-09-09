# AgentCore Runtime

`apps/agent-runtime` owns the trusted SDK loop. The front passes Turn identity,
frozen Scope, Turn budget and Sandbox session id. The Runtime emits raw SDK
messages plus MyMemo artifact/error lines; the front owns UIMessage conversion.

All six file/shell tools use the Hand in the Code Interpreter Sandbox. Paths
are confined to `ws/`; output caps and timeouts are enforced there. Document
tools query the scoped read-only KB and materialize content in `.mymemo/docs/`.
Keep model, KB and AWS credentials out of the Sandbox.

The Runtime downloads the Conversation's one SDK transcript before query and
uploads it afterward under `_transcripts/`. It never writes DynamoDB, history,
or the Workspace tarball. Runtime session id is the Turn id; SDK session id
is the Conversation id. The front owns Sandbox start/stop and Workspace copy.

See [the Runtime README](../../apps/agent-runtime/README.md) and ADR-0035.
