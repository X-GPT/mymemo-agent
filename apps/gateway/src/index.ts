import { loadConfigFromEnv } from "./config";
import { createDb } from "./db";
import { createGateway } from "./gateway";

// Entrypoint — the only place that reads the environment. Parse/validate once,
// then inject the typed config into the app and the Db so no other module is
// coupled to global process state.
const config = loadConfigFromEnv(Bun.env);
const db = createDb(config.databaseUrl);
const app = createGateway(config, db);

export default {
	port: config.gatewayPort,
	fetch: app.fetch,
};
