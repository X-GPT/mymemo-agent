// chat-api's binding to the shared writable agent-DB test harness.
// `createTestDatabase` (PGlite + migration replay) now lives in
// `@mymemo/agent-db`, so chat-api and Runtime tests exercise the identical
// schema. This re-export keeps chat-api's `@/db/testing` import path unchanged.
export * from "@mymemo/agent-db/testing";
