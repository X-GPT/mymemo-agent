// Set required env vars before any module evaluation.
// This runs as a Bun test preload so env.ts IIFE won't crash.
import { tmpdir } from "node:os";
import { join } from "node:path";

Bun.env.E2B_API_KEY = Bun.env.E2B_API_KEY ?? "test-e2b-key";
Bun.env.LLM_TOKEN_SECRET = Bun.env.LLM_TOKEN_SECRET ?? "test-llm-token-secret";
Bun.env.GATEWAY_PUBLIC_URL =
	Bun.env.GATEWAY_PUBLIC_URL ?? "https://gateway.test";
// AGENT_DATABASE_URL is required at config load; tests inject fake stores, and
// the Drizzle client connects lazily, so a non-connecting placeholder is enough.
Bun.env.AGENT_DATABASE_URL =
	Bun.env.AGENT_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
// Run tests with the exposure gate in break-glass mode. This lets config load
// without a Statsig secret AND, crucially, makes the entrypoint's default export
// (`createApp(loadApiConfigFromEnv(Bun.env))`, evaluated whenever a test imports
// `@/index`) build a BreakGlassExposureGate — so no real Statsig client is
// constructed and no network I/O fires at import time. Gate-specific tests
// construct StatsigExposureGate directly with a fake/offline client.
Bun.env.AGENT_EXPOSURE_BREAK_GLASS =
	Bun.env.AGENT_EXPOSURE_BREAK_GLASS ?? "true";
// Keep the durable workspace store off the host's real root during tests.
Bun.env.WORKSPACE_STORE_ROOT =
	Bun.env.WORKSPACE_STORE_ROOT ??
	join(tmpdir(), "chat-api-workspace-store-test");
