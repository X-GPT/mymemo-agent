import { describe, expect, it } from "bun:test";
import type {
	AcquireAgentCoreDispatchResult,
	AgentCoreDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import {
	createAcquisitionReceipt,
	serializeCanaryDispatchEnvelope,
} from "agentcore-canary-dispatch/contract";
import {
	createCanaryRuntime,
	RuntimeBusyError,
	RuntimeShuttingDownError,
} from "./runtime";

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function dispatch(runId = "run-451"): AgentCoreDispatchIdentity {
	return {
		schemaVersion: 2,
		userId: "canary-service-user",
		conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045101",
		runId,
		runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045101",
		admittedAt: new Date("2026-08-14T18:00:00.000Z"),
	};
}

function acquisition(
	dispatched: AgentCoreDispatchIdentity,
	result: AcquireAgentCoreDispatchResult,
) {
	return {
		dispatch: dispatched,
		result,
		receiptLine: `${JSON.stringify(
			createAcquisitionReceipt(
				dispatched,
				result,
				new Date("2026-08-14T18:00:01.000Z"),
			),
		)}\n`,
	};
}

describe("AgentCore canary Runtime", () => {
	it("keeps detached acquired work busy until shared Run serving ends", async () => {
		const dispatched = dispatch();
		const served = deferred<{
			type: "terminal";
			status: "done";
		}>();
		const acquired = acquisition(dispatched, {
			disposition: "acquired",
			owner: {
				userId: dispatched.userId,
				conversationId: dispatched.conversationId,
				epoch: 7,
			},
			workerId: "boot-1/invocation-1",
		});
		let serveCount = 0;
		const released = deferred<void>();
		let executionSignal: AbortSignal | undefined;
		const runtime = createCanaryRuntime({
			acquire: async () => acquired,
			serve: async ({ shutdownSignal }) => {
				serveCount++;
				executionSignal = shutdownSignal;
				return await served.promise;
			},
			heartbeat: async () => "alive",
			release: async () => {
				released.resolve();
			},
			heartbeatIntervalMs: 10,
		});

		expect(runtime.health()).toEqual({ status: "Healthy" });
		const invocation = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
			runtimeSessionId: dispatched.runtimeSessionId,
		});
		const reader = invocation.body.getReader();
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe(acquired.receiptLine);
		await reader.cancel("consumer disconnected after receipt");

		expect(runtime.health()).toEqual({ status: "HealthyBusy" });
		expect(serveCount).toBe(1);
		expect(executionSignal?.aborted).toBe(false);

		served.resolve({ type: "terminal", status: "done" });
		await released.promise;
		await Bun.sleep(0);

		expect(runtime.health()).toEqual({ status: "Healthy" });
	});

	it("rechecks durable disposition for an active duplicate while refusing different work", async () => {
		const activeDispatch = dispatch("run-active");
		const otherDispatch = {
			...dispatch("run-other"),
			conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045102",
			runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045102",
		};
		const serving = deferred<{
			type: "terminal";
			status: "done";
		}>();
		const acquiredResult = {
			disposition: "acquired",
			owner: {
				userId: activeDispatch.userId,
				conversationId: activeDispatch.conversationId,
				epoch: 8,
			},
			workerId: "boot-1/invocation-1",
		} as const;
		const acquired = acquisition(activeDispatch, acquiredResult);
		let acquisitionCount = 0;
		let serveCount = 0;
		const runtime = createCanaryRuntime({
			acquire: async (incoming) => {
				acquisitionCount++;
				expect(incoming).toEqual(activeDispatch);
				if (acquisitionCount === 1) return acquired;
				return acquisition(activeDispatch, {
					disposition: "already_acquired",
					owner: acquiredResult.owner,
					workerId: acquiredResult.workerId,
				});
			},
			serve: async () => {
				serveCount++;
				return await serving.promise;
			},
			heartbeat: async () => "alive",
			release: async () => {},
			heartbeatIntervalMs: 10,
		});

		const original = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(activeDispatch),
			runtimeSessionId: activeDispatch.runtimeSessionId,
		});
		const duplicate = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(activeDispatch),
			runtimeSessionId: activeDispatch.runtimeSessionId,
		});
		expect(await new Response(duplicate.body).text()).toBe(
			acquisition(activeDispatch, {
				disposition: "already_acquired",
				owner: acquiredResult.owner,
				workerId: acquiredResult.workerId,
			}).receiptLine,
		);
		await expect(
			runtime.invoke({
				rawEnvelope: serializeCanaryDispatchEnvelope(otherDispatch),
				runtimeSessionId: otherDispatch.runtimeSessionId,
			}),
		).rejects.toBeInstanceOf(RuntimeBusyError);
		expect(acquisitionCount).toBe(2);
		expect(serveCount).toBe(1);

		serving.resolve({ type: "terminal", status: "done" });
		await new Response(original.body).text();
	});

	it("reports the durable unavailable disposition after active execution loses Ownership", async () => {
		const dispatched = dispatch("run-ownership-lost-duplicate");
		const serving = deferred<{
			type: "terminal";
			status: null;
		}>();
		const ownershipLost = deferred<void>();
		let acquisitionCount = 0;
		let releaseCount = 0;
		const runtime = createCanaryRuntime({
			acquire: async (incoming) => {
				acquisitionCount++;
				expect(incoming).toEqual(dispatched);
				if (acquisitionCount > 1) {
					return acquisition(dispatched, {
						disposition: "temporarily_unavailable",
					});
				}
				return acquisition(dispatched, {
					disposition: "acquired",
					owner: {
						userId: dispatched.userId,
						conversationId: dispatched.conversationId,
						epoch: 9,
					},
					workerId: "boot-1/invocation-lost",
				});
			},
			serve: async () => await serving.promise,
			heartbeat: async () => {
				ownershipLost.resolve();
				return "lost";
			},
			release: async () => {
				releaseCount++;
			},
			heartbeatIntervalMs: 1,
		});

		const original = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
			runtimeSessionId: dispatched.runtimeSessionId,
		});
		await ownershipLost.promise;
		const duplicate = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
			runtimeSessionId: dispatched.runtimeSessionId,
		});
		expect(await new Response(duplicate.body).text()).toContain(
			'"disposition":"temporarily_unavailable"',
		);
		expect(acquisitionCount).toBe(2);
		expect(releaseCount).toBe(0);

		serving.resolve({ type: "terminal", status: null });
		await new Response(original.body).text();
		expect(runtime.health()).toEqual({ status: "Healthy" });
	});

	it("coalesces an exact duplicate while the original acquisition is pending", async () => {
		const activeDispatch = dispatch("run-acquiring");
		const otherDispatch = {
			...dispatch("run-waiting"),
			conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045103",
			runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045103",
		};
		const firstAcquisition = deferred<ReturnType<typeof acquisition>>();
		let acquisitionCount = 0;
		let serveCount = 0;
		const runtime = createCanaryRuntime({
			acquire: async () => {
				acquisitionCount++;
				return await firstAcquisition.promise;
			},
			serve: async () => {
				serveCount++;
				return { type: "terminal", status: "done" };
			},
			heartbeat: async () => "alive",
			release: async () => {},
			heartbeatIntervalMs: 10,
		});

		const original = runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(activeDispatch),
			runtimeSessionId: activeDispatch.runtimeSessionId,
		});
		const duplicate = runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(activeDispatch),
			runtimeSessionId: activeDispatch.runtimeSessionId,
		});
		await expect(
			runtime.invoke({
				rawEnvelope: serializeCanaryDispatchEnvelope(otherDispatch),
				runtimeSessionId: otherDispatch.runtimeSessionId,
			}),
		).rejects.toBeInstanceOf(RuntimeBusyError);
		expect(acquisitionCount).toBe(1);

		firstAcquisition.resolve(
			acquisition(activeDispatch, {
				disposition: "acquired",
				owner: {
					userId: activeDispatch.userId,
					conversationId: activeDispatch.conversationId,
					epoch: 12,
				},
				workerId: "boot-1/invocation-acquiring",
			}),
		);
		const [originalInvocation, duplicateInvocation] = await Promise.all([
			original,
			duplicate,
		]);
		expect(await new Response(duplicateInvocation.body).text()).toBe(
			await new Response(originalInvocation.body).text(),
		);
		expect(serveCount).toBe(1);
	});

	it("stays busy after Run detachment and does not release after renewal loses Ownership", async () => {
		const dispatched = dispatch("run-detached");
		const finishServing = deferred<{
			type: "terminal";
			status: null;
		}>();
		const ownershipLost = deferred<void>();
		let releaseCount = 0;
		const runtime = createCanaryRuntime({
			acquire: async () =>
				acquisition(dispatched, {
					disposition: "acquired",
					owner: {
						userId: dispatched.userId,
						conversationId: dispatched.conversationId,
						epoch: 9,
					},
					workerId: "boot-1/invocation-detached",
				}),
			serve: async ({ onDetached }) => {
				onDetached({ type: "run_detached" });
				return await finishServing.promise;
			},
			heartbeat: async ({ detached }) => {
				if (!detached) return "alive";
				ownershipLost.resolve();
				return "lost";
			},
			release: async () => {
				releaseCount++;
			},
			heartbeatIntervalMs: 1,
		});

		const invocation = await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
			runtimeSessionId: dispatched.runtimeSessionId,
		});
		await ownershipLost.promise;
		expect(runtime.health()).toEqual({ status: "HealthyBusy" });

		finishServing.resolve({ type: "terminal", status: null });
		await new Response(invocation.body).text();
		expect(releaseCount).toBe(0);
		expect(runtime.health()).toEqual({ status: "Healthy" });
	});

	it("rejects acquisition during graceful shutdown and lets shared serving terminalize and release", async () => {
		const dispatched = dispatch("run-shutdown");
		let releaseCount = 0;
		const shutdownObserved = deferred<void>();
		const runtime = createCanaryRuntime({
			acquire: async () =>
				acquisition(dispatched, {
					disposition: "acquired",
					owner: {
						userId: dispatched.userId,
						conversationId: dispatched.conversationId,
						epoch: 10,
					},
					workerId: "boot-1/invocation-shutdown",
				}),
			serve: async ({ shutdownSignal }) => {
				await new Promise<void>((resolve) => {
					if (shutdownSignal.aborted) resolve();
					else
						shutdownSignal.addEventListener("abort", () => resolve(), {
							once: true,
						});
				});
				shutdownObserved.resolve();
				return { type: "shutdown", status: "error" };
			},
			heartbeat: async () => "alive",
			release: async () => {
				releaseCount++;
			},
			heartbeatIntervalMs: 5,
		});

		await runtime.invoke({
			rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
			runtimeSessionId: dispatched.runtimeSessionId,
		});
		const shutdown = runtime.shutdown(50);
		await shutdownObserved.promise;
		await expect(
			runtime.invoke({
				rawEnvelope: serializeCanaryDispatchEnvelope(dispatched),
				runtimeSessionId: dispatched.runtimeSessionId,
			}),
		).rejects.toBeInstanceOf(RuntimeShuttingDownError);
		await shutdown;

		expect(releaseCount).toBe(1);
		expect(runtime.health()).toEqual({ status: "Healthy" });
	});
});
