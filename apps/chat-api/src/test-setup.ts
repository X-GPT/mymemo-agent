// Set required env vars before any module evaluation.
// This runs as a Bun test preload so env.ts IIFE won't crash.
import { tmpdir } from "node:os";
import { join } from "node:path";

Bun.env.E2B_API_KEY = Bun.env.E2B_API_KEY ?? "test-e2b-key";
Bun.env.DAEMON_AUTH_TOKEN =
	Bun.env.DAEMON_AUTH_TOKEN ?? "test-daemon-auth-token";
Bun.env.LLM_TOKEN_SECRET = Bun.env.LLM_TOKEN_SECRET ?? "test-llm-token-secret";
Bun.env.GATEWAY_PUBLIC_URL =
	Bun.env.GATEWAY_PUBLIC_URL ?? "https://gateway.test";
// Keep the durable workspace store off the host's real root during tests.
Bun.env.WORKSPACE_STORE_ROOT =
	Bun.env.WORKSPACE_STORE_ROOT ??
	join(tmpdir(), "chat-api-workspace-store-test");
