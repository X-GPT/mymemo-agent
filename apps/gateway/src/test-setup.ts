// Set the env the merged gateway validates at module load, before any test
// module imports `./index`. Mirrors apps/chat-api/src/test-setup.ts and keeps
// individual test files free of module-top `Bun.env` side effects (which leak
// across packages when tests share a process). `??` so an explicit value —
// e.g. a real DATABASE_URL for the gated integration test — is preserved.
Bun.env.ANTHROPIC_API_KEY = Bun.env.ANTHROPIC_API_KEY ?? "test-anthropic-key";
Bun.env.DATABASE_URL = Bun.env.DATABASE_URL ?? "postgres://test@localhost/test";
Bun.env.LLM_TOKEN_SECRET = Bun.env.LLM_TOKEN_SECRET ?? "test-secret";
