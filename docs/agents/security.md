# Security boundaries

Use this guide for changes involving identity, authorization, feature exposure, credentials, Searchable document access, E2B, Redis, or artifacts.

## Identity and authorization

- Identity arrives through trusted `X-*` headers, never through the JSON body.
- chat-api does not authenticate users; the internal gateway or BFF authenticates and forwards identity. The service must be reachable only by trusted internal callers.
- Request-body schemas are strict.
- Conversation Scope is frozen at creation, and every Conversation, Run, history, and artifact resource is owner-scoped.

## Exposure gate

New agent work is gated by the server-side Statsig gate `mymemo_agent_split_runtime_enabled` in `apps/chat-api/src/features/exposure-gate/`. Evaluate it on trusted identity after identity parsing and before any Conversation or Run write. A denial returns `403 { error: "Agent is not enabled" }`; gate errors fail closed.

Production `createExposureGate(config)` always selects the fail-closed `StatsigExposureGate`. The development-only Chat API composition injects its always-open gate directly and is not selectable through production configuration.

After exposure allows Conversation creation, chat-api persists the frozen Scope. Runtime selection is not an input or operational control, and Statsig failures cannot select Fargate. chat-api records AgentCore dispatch only in Postgres and holds no SQS or SSM authority.

Reconnect, interruption, history, artifact access, and Conversation management for existing owned resources do not consult the exposure gate.

## Runtime trust boundary

Treat the E2B sandbox as untrusted because it runs prompt-injectable file and Bash operations. Do not place provider, database, Searchable document, Redis, AWS, or E2B credentials in the sandbox environment.

chat-api's production `ApiConfig` must not hold KB or E2B credentials. It admits Runs, serves history and artifact metadata, attaches clients to Live Streams, and signs read-only artifact URLs. The one exception is the local-only `HarnessConfig` for the AI SDK chat path, which additionally holds the Vercel token triple, the OpenRouter credential, and the read-only `KB_DATABASE_URL`, because chat-api executes the document tools itself; only `apps/chat-api/src/features/ai-chat/tools/` touches the KB, and chat-api holds no E2B credential. `env.test.ts` pins that the production `ApiConfig` never reads any of them.

The production AgentCore Runtime alone owns product Run model traffic, scoped
Searchable document access, E2B execution, relay production, and Downloadable
artifact publication. On the AI SDK chat path (`POST /api/chat`, local
composition only) the Harness sandbox is the trust boundary: Claude Code runs
inside a Vercel Sandbox with `Read`, `Write`, `Edit`, and `Grep` enabled and
every other built-in disabled; its other tools are the chat-api-hosted
document tools (`ListDocuments`, `SearchDocuments`, `LoadDocuments`), which
run in the chat-api process against the read-only KB and write documents into
the sandbox through its session; the sandbox holds no MyMemo secret. The model credential is
brokered — the adapter replaces it with a placeholder before it reaches the
sandbox and the Vercel firewall injects the real bearer only on requests to
the OpenRouter host. The file tools reach the whole sandbox filesystem —
including the bridge's on-disk start config with the brokered placeholder,
and the Claude settings files, which the bridge leaves loaded (`settingSources`
unset) so a written `hooks` command runs shell in the next turn's fresh Claude
process — so the sandbox, not the tool list, is the boundary; the route is
accepted on stage 1's grounds (the placeholder is honoured only from inside
it) and closing it is production readiness (ADR-0033). Every tool input
and output is persisted verbatim in the sandbox's Claude transcript and
therefore in the per-Conversation Vercel snapshot. The sandbox receives no
database, E2B, Searchable document, Redis, or Downloadable artifact authority.
The AgentCore Runtime's KB credential is read-only and separate from the
writable `mymemo_agent` credential. The maintenance service receives only writable agent DB, E2B
cleanup, and artifact-delete authority; it cannot serve Runs.
