import type { WorkerLogger } from "agent-worker/logger";

interface MaintenanceRunnerLifecycle {
	start(): Promise<void>;
	stop(): void;
}

interface HealthServer {
	stop(): void;
}

interface ServeOptions {
	port: number;
	fetch(request: Request): Response | Promise<Response>;
}

type Serve = (options: ServeOptions) => HealthServer;

export async function startMaintenanceService(options: {
	runner: MaintenanceRunnerLifecycle;
	port: number;
	logger: WorkerLogger;
	serve?: Serve;
}) {
	await options.runner.start();
	const server = (options.serve ?? Bun.serve)({
		port: options.port,
		fetch(request) {
			if (new URL(request.url).pathname === "/health") {
				return Response.json({ status: "ok", service: "agent-maintenance" });
			}
			return new Response("not found", { status: 404 });
		},
	});
	options.logger.info({
		message: "agent-maintenance health server listening",
		port: options.port,
	});

	return {
		async stop(): Promise<void> {
			options.runner.stop();
			server.stop();
		},
	};
}
