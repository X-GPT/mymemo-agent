import { describe, expect, it } from "bun:test";
import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { createCanaryDispatchConsumer } from "./consumer";
import {
	createAcquisitionReceipt,
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

async function* wireChunks(value: unknown): AsyncIterable<Uint8Array> {
	const wire = `${JSON.stringify(value)}\n`;
	yield new TextEncoder().encode(wire.slice(0, 17));
	yield new TextEncoder().encode(wire.slice(17));
}

describe("Canary SQS consumer", () => {
	it("acknowledges only a strictly correlated committed acquisition receipt", async () => {
		let closed = false;
		const alarms: unknown[] = [];
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async (received) => {
					expect(received).toEqual(dispatch);
					return {
						chunks: wireChunks(
							createAcquisitionReceipt(dispatch, {
								disposition: "acquired",
								owner: {
									userId: dispatch.userId,
									conversationId: dispatch.conversationId,
									epoch: 1,
								},
								workerId: "boot-1/invocation-1",
							}),
						),
						close: () => {
							closed = true;
						},
					};
				},
			},
			alarm: {
				raise: async (alarm) => {
					alarms.push(alarm);
				},
			},
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "sqs-message-1",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({ batchItemFailures: [] });
		expect(closed).toBe(true);
		expect(alarms).toEqual([]);
	});

	it("does not turn a durable acknowledgement into a retry when stream cleanup fails", async () => {
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async () => ({
					chunks: wireChunks(
						createAcquisitionReceipt(dispatch, {
							disposition: "acquired",
							owner: {
								userId: dispatch.userId,
								conversationId: dispatch.conversationId,
								epoch: 1,
							},
							workerId: "boot-1/invocation-1",
						}),
					),
					close: () => {
						throw new Error("stream cleanup failed");
					},
				}),
			},
			alarm: { raise: async () => {} },
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "sqs-message-1",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({ batchItemFailures: [] });
	});

	it.each([
		"already_acquired",
		"terminal",
	] as const)("acknowledges a correlated %s disposition", async (disposition) => {
		const result =
			disposition === "already_acquired"
				? {
						disposition,
						owner: {
							userId: dispatch.userId,
							conversationId: dispatch.conversationId,
							epoch: 3,
						},
						workerId: "boot-1/original-invocation",
					}
				: { disposition, status: "done" as const };
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async () => ({
					chunks: wireChunks(createAcquisitionReceipt(dispatch, result)),
					close: () => {},
				}),
			},
			alarm: { raise: async () => {} },
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "sqs-message-1",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({ batchItemFailures: [] });
	});

	it("retries temporary acquisition and ambiguous Runtime output", async () => {
		let invocation = 0;
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async () => {
					invocation += 1;
					return {
						chunks:
							invocation === 1
								? wireChunks(
										createAcquisitionReceipt(dispatch, {
											disposition: "temporarily_unavailable",
										}),
									)
								: wireChunks({ type: "RUN_STARTED", runId: dispatch.runId }),
						close: () => {},
					};
				},
			},
			alarm: { raise: async () => {} },
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "temporary-message",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
					{
						messageId: "ag-ui-looking-message",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({
			batchItemFailures: [
				{ itemIdentifier: "temporary-message" },
				{ itemIdentifier: "ag-ui-looking-message" },
			],
		});
	});

	it("acknowledges and alarms poison envelopes and invalid dispatches", async () => {
		const alarms: unknown[] = [];
		let invoked = 0;
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async () => {
					invoked += 1;
					return {
						chunks: wireChunks(
							createAcquisitionReceipt(dispatch, {
								disposition: "invalid_dispatch",
							}),
						),
						close: () => {},
					};
				},
			},
			alarm: {
				raise: async (alarm) => {
					alarms.push(alarm);
				},
			},
		});

		await expect(
			consumer.handle({
				Records: [
					{ messageId: "malformed", body: "not-json" },
					{
						messageId: "invalid",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({ batchItemFailures: [] });
		expect(invoked).toBe(1);
		expect(alarms).toEqual([
			{ reason: "invalid_envelope", messageId: "malformed" },
			{
				reason: "invalid_dispatch",
				messageId: "invalid",
				dispatchId: dispatch.dispatchId,
			},
		]);
	});

	it("fails closed without Runtime acquisition when disabled", async () => {
		let invoked = false;
		const alarms: unknown[] = [];
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => false },
			runtime: {
				invoke: async () => {
					invoked = true;
					throw new Error("must not invoke");
				},
			},
			alarm: {
				raise: async (alarm) => {
					alarms.push(alarm);
				},
			},
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "disabled-message",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({
			batchItemFailures: [{ itemIdentifier: "disabled-message" }],
		});
		expect(invoked).toBe(false);
		expect(alarms).toEqual([
			{ reason: "disabled_delivery", messageId: "disabled-message" },
		]);
	});

	it("acknowledges and alarms for a poison receipt whose identifiers do not exactly correlate", async () => {
		const mismatched = { ...dispatch, runId: "another-run" };
		const alarms: unknown[] = [];
		const consumer = createCanaryDispatchConsumer({
			control: { isEnabled: async () => true },
			runtime: {
				invoke: async () => ({
					chunks: wireChunks(
						createAcquisitionReceipt(mismatched, {
							disposition: "terminal",
							status: "done",
						}),
					),
					close: () => {},
				}),
			},
			alarm: {
				raise: async (alarm) => {
					alarms.push(alarm);
				},
			},
		});

		await expect(
			consumer.handle({
				Records: [
					{
						messageId: "mismatch",
						body: serializeCanaryDispatchEnvelope(dispatch),
					},
				],
			}),
		).resolves.toEqual({ batchItemFailures: [] });
		expect(alarms).toEqual([
			{
				reason: "receipt_mismatch",
				messageId: "mismatch",
				dispatchId: dispatch.dispatchId,
			},
		]);
	});
});
