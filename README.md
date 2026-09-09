# MyMemo agent

A Bun-workspace TypeScript service: the Lambda front records Conversations
and streams Turns; the AgentCore Runtime runs the Claude Agent SDK with a
Code Interpreter Hand. DynamoDB holds Conversation state, S3 holds history,
Workspaces, Artifacts and transcripts. The shared KB Postgres stays read-only.

| Workspace | Purpose |
| --- | --- |
| `apps/agent-front` | Chat surface, Turn admission, durable state and Cleanup sweep |
| `apps/agent-runtime` | Trusted model loop, Hand and scoped document tools |
| `packages/document-tools` | Knowledge-base queries and Docs cache |
| `packages/ui-catalog` | Generative-UI schema |
| `packages/test-support` | Shared test utilities |

```sh
bun install --frozen-lockfile
bun run test
scripts/deploy/build_front.sh
```

See [development](docs/agents/development.md), [domain language](CONTEXT.md),
[front operations](docs/runbooks/agent-front.md), and
[Runtime operations](docs/runbooks/agent-runtime.md).

Production releases use the main-only `release-deploy.yml` workflow.
Before the first release of the v1-removal commit, an operator must run
`scripts/deploy/teardown_v1.sh` as described in
[the two-phase teardown runbook](docs/runbooks/v1-teardown.md).
