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
import { RUNTIME_SHUTDOWN_TIMEOUT_MS } from "./constants";

type AcquiredDispatch = Extract<
	AcquireCanaryDispatchResult,
	{ disposition: "acquired" }
>;

export interface AcquiredExecutionIdentity {
	owner: ConversationOwner;
	workerId: string;
	runId: string;
}

export interface CanaryRuntimeDependencies {
	acquire(
		dispatch: CanaryDispatchIdentity,
	): Promise<CommittedCanaryAcquisition>;
	serve(input: {
		dispatch: CanaryDispatchIdentity;
		acquisition: AcquiredDispatch;
		shutdownSignal: AbortSignal;
		onDetached(event: {
			type: "run_detached" | "ownership_lost";
			reason?: "lease" | "gone";
		}): void;
	}): Promise<ServeStartedRunResult>;
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

interface PendingAcquisition {
	dispatch: CanaryDispatchIdentity;
	promise: Promise<CommittedCanaryAcquisition>;
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

function executionIdentity(entry: ActiveExecution): AcquiredExecutionIdentity {
	return {
		owner: entry.acquisition.owner,
		workerId: entry.acquisition.workerId,
		runId: entry.dispatch.runId,
	};
}

function receiptInvocation(receiptLine: string): RuntimeInvocation {
	return { body: new Blob([receiptLine]).stream() };
}

function requireSameDispatch(
	occupied: CanaryDispatchIdentity,
	incoming: CanaryDispatchIdentity,
): void {
	if (!sameCanaryDispatch(occupied, incoming)) {
		throw new RuntimeBusyError("AgentCore Runtime is busy");
	}
}

export function createCanaryRuntime(dependencies: CanaryRuntimeDependencies) {
	let active: ActiveExecution | undefined;
	let pendingAcquisition: PendingAcquisition | undefined;
	let shuttingDown = false;
	const currentExecution = () => active;

	async function execute(entry: ActiveExecution): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const heartbeat = async (): Promise<void> => {
			if (active !== entry) return;
			let renewal: "alive" | "lost" = "alive";
			try {
				renewal = await dependencies.heartbeat({
					...executionIdentity(entry),
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
				await dependencies.release(executionIdentity(entry));
			}
		} finally {
			if (timer) clearTimeout(timer);
			if (active === entry) active = undefined;
		}
	}

	return {
		health(): { status: "Healthy" | "HealthyBusy" } {
			return {
				status: active || pendingAcquisition ? "HealthyBusy" : "Healthy",
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
			const current = currentExecution();
			if (current) {
				requireSameDispatch(current.dispatch, dispatch);
				const duplicate = await dependencies.acquire(dispatch);
				return receiptInvocation(duplicate.receiptLine);
			}
			if (pendingAcquisition) {
				requireSameDispatch(pendingAcquisition.dispatch, dispatch);
			}

			const pending =
				pendingAcquisition ??
				({
					dispatch,
					promise: dependencies.acquire(dispatch),
				} satisfies PendingAcquisition);
			pendingAcquisition = pending;
			let acquired: CommittedCanaryAcquisition;
			try {
				acquired = await pending.promise;
			} finally {
				if (pendingAcquisition === pending) pendingAcquisition = undefined;
			}
			if (acquired.result.disposition !== "acquired") {
				return receiptInvocation(acquired.receiptLine);
			}

			const entry: ActiveExecution = {
				dispatch: acquired.dispatch,
				acquisition: acquired.result,
				shutdownController: new AbortController(),
				detached: false,
				ownershipLost: false,
				done: Promise.resolve(),
			};
			const concurrent = currentExecution();
			if (concurrent) {
				requireSameDispatch(concurrent.dispatch, dispatch);
				return receiptInvocation(acquired.receiptLine);
			}
			active = entry;
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

		async shutdown(timeoutMs = RUNTIME_SHUTDOWN_TIMEOUT_MS): Promise<void> {
			shuttingDown = true;
			const drain = async (): Promise<void> => {
				while (pendingAcquisition) {
					await Promise.allSettled([pendingAcquisition.promise]);
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
