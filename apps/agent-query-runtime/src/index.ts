import { resolveClaudeEnvironment } from "./openrouter";
import { createResponseStream } from "./response-execution";
import { createResponseInvocationHandler } from "./server";

const claudeEnvironment = await resolveClaudeEnvironment(Bun.env);

const port = Number(Bun.env.PORT ?? 8080);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
	throw new Error("PORT must be an integer between 1 and 65535");
}

let shuttingDown = false;

const server = Bun.serve({
	hostname: "0.0.0.0",
	port,
	idleTimeout: 0,
	maxRequestBodySize: 512 * 1024,
	routes: {
		"/ping": {
			GET: () =>
				Response.json(
					{ status: shuttingDown ? "Unhealthy" : "Healthy" },
					{ status: shuttingDown ? 503 : 200 },
				),
		},
		"/invocations": {
			POST: createResponseInvocationHandler((request) => {
				if (shuttingDown) throw new Error("Runtime is shutting down");
				return createResponseStream(request, {
					environment: { ...Bun.env, ...claudeEnvironment },
				});
			}),
		},
	},
});

async function close() {
	if (shuttingDown) return;
	shuttingDown = true;
	await server.stop(true);
	process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());
