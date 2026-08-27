# Host the AI SDK chat loop in a Vercel Sandbox through HarnessAgent

Status: accepted (2026-08-27). Supersedes the AgentCore-hosted Agent-query
Runtime design of issue #560 for the AI SDK chat path. Amends ADR-0001 and
ADR-0031 for that path only; the production Run path is unchanged.

The AI SDK chat route `POST /api/chat` runs Vercel's `@ai-sdk/harness`
`HarnessAgent` inside the chat-api process, with the upstream `createClaudeCode`
adapter and `@ai-sdk/sandbox-vercel`. Each Conversation owns one persistent
Vercel Sandbox — its **Harness sandbox**, named from the Conversation id — that
hosts Claude Code and carries the Conversation's model-side memory in its
filesystem snapshot. chat-api stops the sandbox after every turn and keeps
only a small opaque resume pointer. The Agent-query Runtime on AgentCore, its
S3 detached-session store, and its infrastructure are retired by hard swap.

The trade this records: on this path the agent loop runs *inside* the sandbox,
the shape ADR-0001 rejected for production. It is accepted here because the
sandbox holds no MyMemo secret — the model credential is brokered by the Vercel
provider and appears inside the sandbox only as a placeholder usable against
the OpenRouter host — and because the alternative was owning a Claude-to-Harness
adapter. Stage 1 deliberately runs Claude Code's built-in tools in that
sandbox. Stage 2 disables them, exposes MyMemo's existing tool catalog as host
tools, and reattaches the E2B Workspace, at which point the Harness sandbox is
a trusted host again and the split runtime returns.

## Considered options

- **Custom host-driven `HarnessV1` adapter around the existing direct SDK
  integration.** Rejected for this path because it means owning the
  Claude-to-Harness protocol and lifecycle translation (weeks, per the
  feasibility research) to avoid a boundary the sandbox already provides.
- **Keep the Agent-query Runtime on AgentCore.** Rejected because it is a
  second deployed runtime with its own image, IAM, Terraform, and invocation
  hop for one verification route, and it had no tools.
- **A fresh sandbox per turn with the transcript copied to S3.** Rejected for
  stage 1: `resumeFrom` carries no transcript (proven by resuming with the same
  state into a fresh sandbox — it forgot), so statelessness requires copying
  Claude Code's internal session files ourselves. It costs 1–3 s more per turn
  and has no warm path. It remains the natural shape once the Workspace moves
  to E2B, and a transcript backup can be added to the persistent design later.
- **`detach()` between turns for ~1.3 s resumes.** Deferred: Vercel's `timeout`
  is a wall clock on the running session, so attaching late risks the VM
  dying mid-turn unless it is extended on every attach, and idle VMs consume
  the plan's concurrency cap.

## Consequences

- chat-api holds the Vercel token triple and the OpenRouter credential for this
  path; `docs/agents/security.md` is revised with the implementation.
- Continuity depends on the Vercel snapshot. With default retention a
  Conversation idle for 30 days starts a fresh thread; an unresumable sandbox
  is replaced silently and logged.
- `createClaudeCode({ auth: 'direct' })` is mandatory; `auto` would route the
  model call to the Vercel AI Gateway using the local OIDC token.
- Overlapping turns on one Conversation are refused (`409`) rather than raced,
  because two callers cannot share one running bridge.
- The *Workspace* and *Execution runtime* glossary entries still describe the
  production Run path; the AI SDK chat path has neither until stage 2.
