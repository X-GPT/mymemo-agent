import { query } from "@anthropic-ai/claude-agent-sdk";
import { createDatabase } from "@mymemo/agent-db/client";
import { createRedisTurnLiveStreamRelay } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "./app";
import { loadInVmConfigFromEnv } from "./config";
import { buildTurnQueryOptions } from "./query-options";
import { serveOneTurn, type TurnServingDeps } from "./turn-serving";

export { createApp } from "./app";

// Entrypoint: the only place that reads the environment. One VM serves one
// Conversation; `bun run src/index.ts` serves this default export locally
// (ticket #662 — #666 bakes the server into the MicroVM image).
const config = loadInVmConfigFromEnv(Bun.env);
const logger = pino({ level: config.logLevel });
const relay = createRedisTurnLiveStreamRelay({
	url: config.redisUrl,
	deployment: "current",
});
const deps: TurnServingDeps = {
	db: createDatabase(config.databaseUrl),
	relay,
	userId: config.userId,
	conversationId: config.conversationId,
	query: ({ prompt, options }) => query({ prompt, options }),
	queryOptions: buildTurnQueryOptions({
		workspaceDir: config.workspaceDir,
		model: config.model,
		processEnv: Bun.env,
	}),
	logger,
};

const app = createApp({
	nudge: () => {
		void serveOneTurn(deps).catch((error) => {
			logger.error({ error: String(error) }, "serveOneTurn failed");
		});
	},
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await relay.close().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

export default { port: config.port, fetch: app.fetch };
