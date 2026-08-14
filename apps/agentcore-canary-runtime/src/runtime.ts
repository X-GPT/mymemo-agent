import type {
	AcquireCanaryDispatchResult,
	CanaryDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import type { ConversationOwner } from "@mymemo/agent-db/conversation-ownership";
import type { ServeStartedRunResult } from "agent-worker/run-serving";
import type { CommittedCanaryAcquisition } from "agentcore-canary-dispatch/acquisition-boundary";
import {
	parseCanaryDispatchEnvelope,
	sameCanaryDispatch,
} from "agentcore-canary-dispatch/contract";

export type CanaryRuntimeAcquisition = CommittedCanaryAcquisition;

type AcquiredDispatch = Extract<
	AcquireCanaryDispatchResult,
	{ disposition: "acquired" }
>;

export type RuntimeServingResult = ServeStartedRunResult;

export interface AcquiredExecutionIdentity {
	owner: ConversationOwner;
	workerId: string;
	runId: string;
}

export interface CanaryRuntimeDependencies {
	acquire(rawEnvelope: string): Promise<CanaryRuntimeAcquisition>;
	serve(input: {
		dispatch: CanaryDispatchIdentity;
		acquisition: AcquiredDispatch;
		shutdownSignal: AbortSignal;
		onDetached(event: {
			type: "run_detached" | "ownership_lost";
			reason?: "lease" | "gone";
		}): void;
	}): Promise<RuntimeServingResult>;
	heartbeat(
		input: AcquiredExecutionIdentity & { detached: boolean },
	): Promise<"alive" | "lost">;
	release(input: AcquiredExecutionIdentity): Promise<void>;
	onExecutionError?(error: unknown, dispatch: CanaryDispatchIdentity): void;
	heartbeatIntervalMs: number;
}

interface ActiveExecution {
	dispatch: CanaryDispatchIdentity;
	acquisition: AcquiredDispatch;
	shutdownController: AbortController;
	detached: boolean;
	ownershipLost: boolean;
	done: Promise<void>;
}

export class RuntimeBusyError extends Error {
	override readonly name = "RuntimeBusyError";
}

export class RuntimeShuttingDownError extends Error {
	override readonly name = "RuntimeShuttingDownError";
}

export class RuntimeSessionMismatchError extends Error {
	override readonly name = "RuntimeSessionMismatchError";
}

export interface RuntimeInvocation {
	body: ReadableStream<Uint8Array>;
}

export function createCanaryRuntime(dependencies: CanaryRuntimeDependencies) {
	let active: ActiveExecution | undefined;
	let pendingDispatch: CanaryDispatchIdentity | undefined;
	const pendingAcquisitions = new Set<Promise<CanaryRuntimeAcquisition>>();
	let shuttingDown = false;

	async function execute(entry: ActiveExecution): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const heartbeat = async (): Promise<void> => {
			if (active !== entry) return;
			let renewal: "alive" | "lost" = "alive";
			try {
				renewal = await dependencies.heartbeat({
					owner: entry.acquisition.owner,
					workerId: entry.acquisition.workerId,
					runId: entry.dispatch.runId,
					detached: entry.detached,
				});
			} catch {
				// A transient renewal error does not prove Ownership loss. The shared
				// lease remains the fence and the next cadence retries.
			}
			if (renewal === "lost") entry.ownershipLost = true;
			if (active === entry && !entry.ownershipLost) {
				timer = setTimeout(heartbeat, dependencies.heartbeatIntervalMs);
			}
		};
		timer = setTimeout(heartbeat, dependencies.heartbeatIntervalMs);
		try {
			const result = await dependencies.serve({
				dispatch: entry.dispatch,
				acquisition: entry.acquisition,
				shutdownSignal: entry.shutdownController.signal,
				onDetached(event) {
					entry.detached = true;
					if (event.type === "ownership_lost") entry.ownershipLost = true;
				},
			});
			if (result.type === "ownership_lost") entry.ownershipLost = true;
			if (!entry.ownershipLost) {
				await dependencies.release({
					owner: entry.acquisition.owner,
					workerId: entry.acquisition.workerId,
					runId: entry.dispatch.runId,
				});
			}
		} finally {
			if (timer) clearTimeout(timer);
			if (active === entry) active = undefined;
		}
	}

	return {
		health(): { status: "Healthy" | "HealthyBusy" } {
			return {
				status: active || pendingDispatch ? "HealthyBusy" : "Healthy",
			};
		},

		async invoke(input: {
			rawEnvelope: string;
			runtimeSessionId: string;
		}): Promise<RuntimeInvocation> {
			if (shuttingDown) {
				throw new RuntimeShuttingDownError(
					"AgentCore Runtime is shutting down",
				);
			}
			const dispatch = parseCanaryDispatchEnvelope(input.rawEnvelope);
			if (dispatch.runtimeSessionId !== input.runtimeSessionId) {
				throw new RuntimeSessionMismatchError("Runtime session mismatch");
			}
			const occupied = active?.dispatch ?? pendingDispatch;
			if (occupied && !sameCanaryDispatch(occupied, dispatch)) {
				throw new RuntimeBusyError("AgentCore Runtime is busy");
			}
			pendingDispatch ??= dispatch;

			const pending = dependencies.acquire(input.rawEnvelope);
			pendingAcquisitions.add(pending);
			let acquired: CanaryRuntimeAcquisition;
			try {
				acquired = await pending;
			} finally {
				pendingAcquisitions.delete(pending);
				if (pendingAcquisitions.size === 0 && !active) {
					pendingDispatch = undefined;
				}
			}
			if (acquired.result.disposition !== "acquired") {
				return {
					body: new Blob([acquired.receiptLine]).stream(),
				};
			}

			const entry: ActiveExecution = {
				dispatch: acquired.dispatch,
				acquisition: acquired.result,
				shutdownController: new AbortController(),
				detached: false,
				ownershipLost: false,
				done: Promise.resolve(),
			};
			if (active) {
				if (pendingAcquisitions.size === 0) pendingDispatch = undefined;
				if (
					active.acquisition.owner.epoch === acquired.result.owner.epoch &&
					active.acquisition.workerId === acquired.result.workerId
				) {
					return {
						body: new Blob([acquired.receiptLine]).stream(),
					};
				}
				await dependencies.release({
					owner: acquired.result.owner,
					workerId: acquired.result.workerId,
					runId: acquired.dispatch.runId,
				});
				throw new RuntimeBusyError(
					"AgentCore Runtime acquired duplicate work while busy",
				);
			}
			active = entry;
			pendingDispatch = undefined;
			if (shuttingDown) entry.shutdownController.abort();
			let streamCanceled = false;
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new TextEncoder().encode(acquired.receiptLine));
					entry.done = execute(entry)
						.catch((error) => {
							dependencies.onExecutionError?.(error, entry.dispatch);
						})
						.finally(() => {
							if (!streamCanceled) controller.close();
						});
				},
				cancel() {
					streamCanceled = true;
				},
			});
			return { body };
		},

		async shutdown(timeoutMs = 30_000): Promise<void> {
			shuttingDown = true;
			const drain = async (): Promise<void> => {
				while (pendingAcquisitions.size > 0) {
					await Promise.allSettled([...pendingAcquisitions]);
				}
				active?.shutdownController.abort();
				await active?.done;
			};
			let timer: ReturnType<typeof setTimeout> | undefined;
			const grace = new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
			});
			try {
				await Promise.race([drain(), grace]);
			} finally {
				if (timer) clearTimeout(timer);
			}
		},
	};
}
