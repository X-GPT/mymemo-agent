// Set required env vars before any module evaluation.
// This runs as a Bun test preload so env.ts IIFE won't crash.

// AGENT_DATABASE_URL is required at config load; tests inject fake stores, and
// the Drizzle client connects lazily, so a non-connecting placeholder is enough.
Bun.env.AGENT_DATABASE_URL =
	Bun.env.AGENT_DATABASE_URL ?? "postgresql://test:test@localhost:5432/test";
Bun.env.ARTIFACT_BUCKET =
	Bun.env.ARTIFACT_BUCKET ?? "mymemo-agent-test-artifacts";
Bun.env.AWS_REGION = Bun.env.AWS_REGION ?? "us-west-2";
// Production composition always requires Statsig. Tests inject their own gates;
// this placeholder only lets imports of the production entrypoint validate.
Bun.env.STATSIG_SERVER_SECRET =
	Bun.env.STATSIG_SERVER_SECRET ?? "test-statsig-secret";
