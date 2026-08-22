import { createDatabase } from "@mymemo/agent-db/client";
import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { createLocalAgentCoreDispatchBridge } from "./bridge";

function required(name: string): string {
	const value = Bun.env[name]?.trim();
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function positiveInt(name: string, fallback: number): number {
	const raw = Bun.env[name];
	if (raw === undefined) return fallback;
	const value = Number(raw);
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`${name} must be a positive integer`);
	}
	return value;
}

const databaseUrl = resolveDatabaseUrl(
	required("AGENT_DATABASE_URL"),
	Bun.env.DB_PASSWORD,
	Bun.env.DB_SSL,
);
const db = createDatabase(databaseUrl);
const bridge = createLocalAgentCoreDispatchBridge({
	db,
	publisherId: `local-bridge/${crypto.randomUUID()}`,
	runtimeUrl: required("AGENTCORE_RUNTIME_URL"),
	invocationTimeoutMs: positiveInt("AGENTCORE_INVOCATION_TIMEOUT_MS", 30_000),
});
const pollIntervalMs = positiveInt("AGENTCORE_POLL_INTERVAL_MS", 250);
let stopping = false;
process.once("SIGINT", () => {
	stopping = true;
});
process.once("SIGTERM", () => {
	stopping = true;
});

while (!stopping) {
	try {
		const result = await bridge.pollOnce();
		if (result.publishedRunIds.length > 0) {
			console.info(
				JSON.stringify({
					message: "local AgentCore Dispatch handled",
					runIds: result.publishedRunIds,
				}),
			);
		}
	} catch (error) {
		console.error(
			JSON.stringify({
				message: "local AgentCore Dispatch poll failed",
				error: error instanceof Error ? error.message : String(error),
			}),
		);
	}
	if (!stopping) await Bun.sleep(pollIntervalMs);
}

await db.$client.end();
