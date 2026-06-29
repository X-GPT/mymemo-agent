import type { WorkerLogger } from "./logger";
import type { Worker } from "./worker";

/** Map the worker's health snapshot to an HTTP response. Pure; easy to test. */
export function buildHealthResponse(worker: Worker): Response {
	return Response.json(worker.healthSnapshot());
}

/**
 * Serve `GET /health` for ECS/ALB liveness. The snapshot is deterministic for a
 * given worker state, so the health check reflects real readiness (concurrency,
 * draining) rather than a static 200.
 */
export function startHealthServer(
	worker: Worker,
	port: number,
	logger: WorkerLogger,
) {
	const server = Bun.serve({
		port,
		fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health") return buildHealthResponse(worker);
			return new Response("not found", { status: 404 });
		},
	});
	logger.info({ message: "Health server listening", port });
	return server;
}
