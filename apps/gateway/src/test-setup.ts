// Set the env the merged gateway validates at module load, before any test
// module imports `./index`. Mirrors apps/chat-api/src/test-setup.ts and keeps
// individual test files free of module-top `Bun.env` side effects (which leak
// across packages when tests share a process).
//
// `??` for values a test may legitimately override from the ambient env — e.g.
// a real DATABASE_URL for the gated integration test.
Bun.env.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY ?? "test-anthropic-key";
Bun.env.DATABASE_URL = Bun.env.DATABASE_URL ?? "postgres://test@localhost/test";
// Pinned, NOT `??`: index.test.ts signs tokens with a hardcoded "test-secret"
// constant, so the gateway must verify with that exact value. An ambient
// LLM_TOKEN_SECRET would otherwise make signing and verification disagree and
// fail every authed-route test.
Bun.env.LLM_TOKEN_SECRET = "test-secret";
