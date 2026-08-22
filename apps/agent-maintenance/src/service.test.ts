import { describe, expect, it } from "bun:test";
import type { WorkerLogger } from "agent-worker/logger";
import { startMaintenanceService } from "./service";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

describe("agent-maintenance service", () => {
	it("starts maintenance before reporting healthy and stops cleanly", async () => {
		const events: string[] = [];
		const service = await startMaintenanceService({
			runner: {
				async start() {
					events.push("runner:start");
				},
				stop() {
					events.push("runner:stop");
				},
			},
			port: 8080,
			logger: silentLogger,
			serve() {
				events.push("health:start");
				return {
					stop() {
						events.push("health:stop");
					},
				};
			},
		});

		expect(events).toEqual(["runner:start", "health:start"]);
		await service.stop();
		expect(events).toEqual([
			"runner:start",
			"health:start",
			"runner:stop",
			"health:stop",
		]);
	});

	it("serves only its health endpoint", async () => {
		let fetch: ((request: Request) => Response | Promise<Response>) | undefined;
		const service = await startMaintenanceService({
			runner: { async start() {}, stop() {} },
			port: 8080,
			logger: silentLogger,
			serve(options) {
				fetch = options.fetch;
				return { stop() {} };
			},
		});

		expect(await fetch?.(new Request("http://localhost/health"))).toEqual(
			Response.json({ status: "ok", service: "agent-maintenance" }),
		);
		expect((await fetch?.(new Request("http://localhost/runs")))?.status).toBe(
			404,
		);
		await service.stop();
	});
});
