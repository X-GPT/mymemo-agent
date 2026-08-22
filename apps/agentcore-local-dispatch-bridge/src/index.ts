import { createDatabase } from "@mymemo/agent-db/client";
import { resolveDatabaseUrl } from "@mymemo/agent-db/database-url";
import { requireEnv } from "agentcore-dispatch-consumer/config-utils";
import { createLocalAgentCoreDispatchBridge } from "./bridge";

const databaseUrl = resolveDatabaseUrl(
	requireEnv(Bun.env, "AGENT_DATABASE_URL"),
	Bun.env.DB_PASSWORD,
	Bun.env.DB_SSL,
);
const db = createDatabase(databaseUrl);
const bridge = createLocalAgentCoreDispatchBridge({
	db,
	publisherId: `local-bridge/${crypto.randomUUID()}`,
	runtimeUrl: requireEnv(Bun.env, "AGENTCORE_RUNTIME_URL"),
});
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
	if (!stopping) await Bun.sleep(250);
}

await db.$client.end();
