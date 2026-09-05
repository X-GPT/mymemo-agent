# Use Bash for workspace file discovery

Status: accepted

Superseded (2026-09-05) by [ADR-0035](./0035-serve-chat-through-a-lambda-front-and-a-code-interpreter-hand.md): Bash for workspace file discovery (the built-in tools are gone) retires at the v1 cutover.

This decision supersedes the active `Glob` tool portions of ADR-0006 and
ADR-0009. Their records remain unchanged as the history of the tool surface
they introduced.

Amended (2026-08-22) by
[ADR-0031](./0031-make-agentcore-the-sole-execution-runtime.md): AgentCore
Runtime is now the sole trusted executor, while prompt-injectable filesystem
and shell work remains isolated in E2B. The Fargate-tool wording below records
the original decision context.

The custom `Glob` executor was a shallow wrapper around `rg --files`. Its
working-directory and pattern semantics created separate behavior to specify,
test, and secure, including hidden search-root and symlink-root surprises.
`Bash` already runs in the same untrusted E2B sandbox with the same filesystem
authority, so the wrapper did not create a security control that Bash lacked.

Remove `Glob` from the model-facing tool catalog, fail-closed allowlist, system
prompt, executor implementation, configuration, and new Tool-event projection.
Use sandboxed `Bash` with `rg --files`, `find`, or `ls` for filename discovery.
Keep `Grep`: its bounded, sorted path/line/column match structure provides a
stable interface for content search and client Tool events.

Keep `"Glob"` in the shared durable Tool-event vocabulary only so historical
Run events continue to parse and replay. The active executor and projection
allowlists must not accept new `Glob` invocations.

## Consequences

- Filename discovery follows ordinary shell-tool behavior instead of a second
  glob contract.
- The split-runtime seam remains the security control: built-in Fargate tools
  stay disabled, and prompt-injectable filesystem and shell work stays in E2B
  without trusted credentials.
- Historical Conversation history remains readable without keeping dead
  execution code.
