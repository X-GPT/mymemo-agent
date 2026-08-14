import { describe, expect, it } from "bun:test";
import type {
	AcquireCanaryDispatchResult,
	CanaryDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import { createCanaryAcquisitionBoundary } from "./acquisition-boundary";
import {
	parseAcquisitionReceipt,
	serializeCanaryDispatchEnvelope,
} from "./contract";

const dispatch: CanaryDispatchIdentity = {
	schemaVersion: 1,
	dispatchId: "dispatch-450",
	campaignId: "campaign-450",
	scenarioId: "baseline-v1",
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	expectedExecutionLane: "agentcore_canary",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("AgentCore acquisition boundary", () => {
	it("emits one correlated receipt line only after Durable acquisition commits", async () => {
		let finishCommit:
			| ((result: AcquireCanaryDispatchResult) => void)
			| undefined;
		const committed = new Promise<AcquireCanaryDispatchResult>((resolve) => {
			finishCommit = resolve;
		});
		const boundary = createCanaryAcquisitionBoundary({
			control: { isEnabled: async () => true },
			acquire: async (input) => {
				expect(input).toEqual({
					dispatch,
					workerId: "boot-1/invocation-1",
				});
				return await committed;
			},
			createWorkerId: () => "boot-1/invocation-1",
			now: () => new Date("2026-08-14T16:01:00.000Z"),
		});

		let emitted = false;
		const pending = boundary
			.handle(serializeCanaryDispatchEnvelope(dispatch))
			.then((wire) => {
				emitted = true;
				return wire;
			});
		await Promise.resolve();
		expect(emitted).toBe(false);

		finishCommit?.({
			disposition: "acquired",
			owner: {
				userId: dispatch.userId,
				conversationId: dispatch.conversationId,
				epoch: 1,
			},
			workerId: "boot-1/invocation-1",
		});
		const wire = await pending;

		expect(wire.endsWith("\n")).toBe(true);
		expect(parseAcquisitionReceipt(wire.trim())).toMatchObject({
			dispatchId: dispatch.dispatchId,
			disposition: "acquired",
			ownershipEpoch: 1,
			workerId: "boot-1/invocation-1",
			committedAt: "2026-08-14T16:01:00.000Z",
		});
	});

	it("fails closed before Durable acquisition when dispatch is disabled", async () => {
		let acquired = false;
		const boundary = createCanaryAcquisitionBoundary({
			control: { isEnabled: async () => false },
			acquire: async () => {
				acquired = true;
				return { disposition: "temporarily_unavailable" };
			},
			createWorkerId: () => "boot-1/invocation-1",
		});

		await expect(
			boundary.handle(serializeCanaryDispatchEnvelope(dispatch)),
		).rejects.toThrow("Canary dispatch is disabled");
		expect(acquired).toBe(false);
	});
});
