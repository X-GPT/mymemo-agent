import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
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
	invoke(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<AgentCoreRuntimeInvocation>;
}

export interface CanaryDispatchAlarm {
	raise(input: {
		reason:
			| "disabled_delivery"
			| "invalid_envelope"
			| "invalid_dispatch"
			| "receipt_mismatch";
		messageId: string;
		runId?: string;
	}): Promise<void>;
}

export interface CanarySqsEvent {
	Records: Array<{ messageId: string; body: string }>;
}

export interface CanarySqsBatchResponse {
	batchItemFailures: Array<{ itemIdentifier: string }>;
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

		let dispatch: AgentCoreDispatchIdentity;
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
					runId: dispatch.runId,
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
						runId: dispatch.runId,
					});
					return "ack";
				default: {
					const unexpected: never = receipt.disposition;
					throw new Error(
						`unexpected acquisition disposition: ${String(unexpected)}`,
					);
				}
			}
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
				let disposition: "ack" | "retry";
				try {
					disposition = await processRecord(record);
				} catch {
					// Keep an adapter failure scoped to this record so the partial-batch
					// response still preserves decisions made for the remaining records.
					disposition = "retry";
				}
				if (disposition === "retry") {
					failures.push({ itemIdentifier: record.messageId });
				}
			}
			return { batchItemFailures: failures };
		},
	};
}
