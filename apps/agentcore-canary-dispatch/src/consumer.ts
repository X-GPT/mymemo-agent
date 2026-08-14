import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import {
	parseCanaryDispatchEnvelope,
	receiptCorrelatesDispatch,
} from "./contract";
import type { CanaryEnablementControl } from "./publisher";
import { readAcquisitionReceipt } from "./receipt-stream";

export interface AgentCoreRuntimeInvocation {
	chunks: AsyncIterable<Uint8Array>;
	close(): void | Promise<void>;
}

export interface AgentCoreRuntimeInvoker {
	invoke(dispatch: CanaryDispatchIdentity): Promise<AgentCoreRuntimeInvocation>;
}

export interface CanaryDispatchAlarm {
	raise(input: {
		reason:
			| "disabled_delivery"
			| "invalid_envelope"
			| "invalid_dispatch"
			| "receipt_mismatch";
		messageId: string;
		dispatchId?: string;
	}): Promise<void>;
}

export interface CanarySqsEvent {
	Records: Array<{ messageId: string; body: string }>;
}

export interface CanarySqsBatchResponse {
	batchItemFailures: Array<{ itemIdentifier: string }>;
}

function assertNever(value: never): never {
	throw new Error(`unexpected acquisition disposition: ${String(value)}`);
}

export function createCanaryDispatchConsumer(options: {
	control: CanaryEnablementControl;
	runtime: AgentCoreRuntimeInvoker;
	alarm: CanaryDispatchAlarm;
}) {
	async function processRecord(record: {
		messageId: string;
		body: string;
	}): Promise<"ack" | "retry"> {
		if (!(await options.control.isEnabled())) {
			await options.alarm.raise({
				reason: "disabled_delivery",
				messageId: record.messageId,
			});
			return "retry";
		}

		let dispatch: CanaryDispatchIdentity;
		try {
			dispatch = parseCanaryDispatchEnvelope(record.body);
		} catch {
			await options.alarm.raise({
				reason: "invalid_envelope",
				messageId: record.messageId,
			});
			return "ack";
		}

		let invocation: AgentCoreRuntimeInvocation | undefined;
		try {
			invocation = await options.runtime.invoke(dispatch);
			const receipt = await readAcquisitionReceipt(invocation.chunks);
			if (!receiptCorrelatesDispatch(receipt, dispatch)) {
				await options.alarm.raise({
					reason: "receipt_mismatch",
					messageId: record.messageId,
					dispatchId: dispatch.dispatchId,
				});
				return "retry";
			}

			switch (receipt.disposition) {
				case "acquired":
				case "already_acquired":
				case "terminal":
					return "ack";
				case "temporarily_unavailable":
					return "retry";
				case "invalid_dispatch":
					await options.alarm.raise({
						reason: "invalid_dispatch",
						messageId: record.messageId,
						dispatchId: dispatch.dispatchId,
					});
					return "ack";
			}
			return assertNever(receipt.disposition);
		} catch {
			// Invocation, stream, parse, and alarm failures are ambiguous. None
			// authorizes deletion of the SQS delivery.
			return "retry";
		} finally {
			try {
				await invocation?.close();
			} catch {
				// Once a correlated receipt selects the SQS disposition, best-effort
				// stream cleanup cannot reverse that durable decision.
			}
		}
	}

	return {
		async handle(event: CanarySqsEvent): Promise<CanarySqsBatchResponse> {
			const failures: CanarySqsBatchResponse["batchItemFailures"] = [];
			for (const record of event.Records) {
				if ((await processRecord(record)) === "retry") {
					failures.push({ itemIdentifier: record.messageId });
				}
			}
			return { batchItemFailures: failures };
		},
	};
}
