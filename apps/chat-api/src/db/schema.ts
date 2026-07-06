// chat-api's binding to the shared writable agent-DB schema. The tables and
// their migrations now live in `@mymemo/agent-db` (owned jointly with
// agent-worker); this re-export keeps chat-api's `@/db/schema` import path and
// every downstream `import { runs, runEvents } from "@/db/schema"` unchanged.
export * from "@mymemo/agent-db/schema";
