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

chat-api must not hold OpenRouter, KB, or E2B credentials. It admits Runs, serves history and artifact metadata, attaches clients to Live Streams, and signs read-only artifact URLs.

The AgentCore Runtime alone owns model traffic, scoped Searchable document
access, E2B execution, relay production, and Downloadable artifact publication.
Its KB credential is read-only and separate from the writable `mymemo_agent`
credential. The maintenance service receives only writable agent DB, E2B
cleanup, and artifact-delete authority; it cannot serve Runs.
