// chat-api's binding to the shared writable agent-DB client. `createDatabase`
// and the `Database` type now live in `@mymemo/agent-db` (shared with
// AgentCore, one `pg` driver everywhere); this re-export keeps chat-api's
// `@/db/client` import path unchanged.
export * from "@mymemo/agent-db/client";
