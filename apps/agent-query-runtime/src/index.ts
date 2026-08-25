import { mkdir } from "node:fs/promises";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import pino from "pino";
import { createE2bSandboxProvisioner } from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import { createAgentQueryServerOptions } from "./server";
import { createDirectResponseSessionStore } from "./session-store";
import { createDirectResponseWorkspacePreparer } from "./workspace";

const SANDBOX_IDLE_MS = 300_000;

function requireEnv(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

const port = Number(Bun.env.PORT ?? 8080);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
	throw new Error("PORT must be an integer between 1 and 65535");
}
const logger = pino({ level: Bun.env.LOG_LEVEL ?? "info" });
const db = createDatabase(requireEnv("AGENT_DATABASE_URL"));
const prepareWorkspace = createDirectResponseWorkspacePreparer({
	db,
	logger,
	provisioner: createE2bSandboxProvisioner({
		apiKey: requireEnv("E2B_API_KEY"),
		template: requireEnv("WORKER_E2B_TEMPLATE"),
		sandboxIdleMs: SANDBOX_IDLE_MS,
		logger,
	}),
});

Bun.serve(
	createAgentQueryServerOptions(
		{
			query,
			createSessionStore: (owner) =>
				createDirectResponseSessionStore(db, owner),
			async prepareWorkingDirectory(path) {
				await mkdir(path, { recursive: true });
			},
			prepareWorkspace,
			// Production Postgres epoch/deadline enforcement is composed in #565;
			// this Runtime remains outside production until then.
			async verifyResponseAuthority() {},
		},
		port,
	),
);

let shuttingDown = false;
async function close() {
	if (shuttingDown) return;
	shuttingDown = true;
	await db.$client.end().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
