/**
 * Daemon: long-running HTTP server in the E2B sandbox. Owns /turn, request
 * locking, and streaming. Spawns agent.js per turn — never imports the Claude
 * Agent SDK directly, so the daemon bundle's transitive graph stays minimal.
 *
 * This is the entrypoint and the ONLY place that reads the environment for
 * daemon configuration. It parses/validates env once via `loadConfigFromEnv`
 * and injects the typed config into `createDaemon` so no other daemon module is
 * coupled to global process state. (The env forwarded into the spawned agent
 * child — provider gateway URL/token, etc. — is read where it is forwarded in
 * child-spawn.ts, not here.)
 *
 * Env (see config.ts):
 *   DAEMON_PORT       — HTTP port (default 8080).
 *   DAEMON_VERSION    — surfaced by /health for the chat-api bundle check.
 *   DAEMON_AUTH_TOKEN — bearer secret for /turn (unset => every /turn is 401).
 *
 * The daemon holds no provider key: the agent's LLM gateway URL and bearer
 * token arrive per turn in the /turn body and are forwarded into agent.js's env.
 */

import { loadConfigFromEnv } from "./config";
import { createDaemon } from "./daemon";

const config = loadConfigFromEnv(Bun.env);
const app = createDaemon(config);

process.on("uncaughtException", (err) => {
	console.error("Uncaught exception:", err);
});
process.on("unhandledRejection", (err) => {
	console.error("Unhandled rejection:", err);
});

console.log(`Sandbox daemon starting on port ${config.daemonPort}`);

export default {
	port: config.daemonPort,
	fetch: app.fetch,
	// Per-connection idle timeout (Bun caps this at 255s). Must sit above the
	// agent idle watchdog (120s default in config.ts) so that on a genuine hang
	// the daemon emits its own `failed` event before Bun silently drops the
	// socket. During a healthy long tool the agent's `heartbeat` events keep this
	// armed.
	idleTimeout: 240,
};
