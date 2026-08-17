import { createDatabase } from "@mymemo/agent-db/client";
import type { AdvisoryLockPool } from "../cleanup/advisory-lock";
import { loadAgentCoreDispatchPublisherConfigFromEnv } from "../config/env";
import { createLogger } from "../logger";
import { createProductionAgentCoreDispatchPublisher } from "./production";
import { runAgentCoreDispatchPublisher } from "./publisher-loop";

interface PublisherPool extends AdvisoryLockPool {
	end(): Promise<void>;
}

const config = loadAgentCoreDispatchPublisherConfigFromEnv(Bun.env);
const logger = createLogger(config.logLevel);
const publisherId = `publisher/${crypto.randomUUID()}`;
const db = createDatabase(config.agentDatabaseUrl);
const pool = db.$client as unknown as PublisherPool;
const { publisher, pendingStore } = createProductionAgentCoreDispatchPublisher({
	db,
	publisherId,
	config,
});

const shutdown = new AbortController();
const signals = ["SIGTERM", "SIGINT"] as const;
const abort = () => shutdown.abort();
for (const signal of signals) process.on(signal, abort);

logger.info({ message: "AgentCore dispatch publisher started", publisherId });
try {
	await runAgentCoreDispatchPublisher({
		pool,
		publisher,
		pendingStore,
		intervalMs: config.intervalMs,
		signal: shutdown.signal,
		logger,
	});
} finally {
	for (const signal of signals) process.off(signal, abort);
	await pool.end();
	logger.info({ message: "AgentCore dispatch publisher stopped", publisherId });
}
