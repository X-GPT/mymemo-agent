import { describe, expect, it } from "bun:test";
import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import {
	createAcquisitionReceipt,
	parseAcquisitionReceipt,
	parseCanaryDispatchEnvelope,
	sameCanaryDispatch,
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

describe("Canary dispatch envelope", () => {
	it("round-trips only the agreed versioned identifiers, lane, and admission timestamp", () => {
		const wire = serializeCanaryDispatchEnvelope(dispatch);

		expect(JSON.parse(wire)).toEqual({
			schemaVersion: 1,
			dispatchId: "dispatch-450",
			campaignId: "campaign-450",
			scenarioId: "baseline-v1",
			userId: "canary-service-user",
			conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			runId: "run-450",
			runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			expectedExecutionLane: "agentcore_canary",
			admittedAt: "2026-08-14T16:00:00.000Z",
		});
		expect(parseCanaryDispatchEnvelope(wire)).toEqual(dispatch);
	});

	it("compares the complete dispatch identity including admission time", () => {
		expect(sameCanaryDispatch(dispatch, { ...dispatch })).toBe(true);
		expect(
			sameCanaryDispatch(dispatch, {
				...dispatch,
				admittedAt: new Date("2026-08-14T16:00:00.001Z"),
			}),
		).toBe(false);
	});

	it("rejects extra content and a Runtime session that does not name the Conversation", () => {
		expect(() =>
			parseCanaryDispatchEnvelope(
				JSON.stringify({
					...JSON.parse(serializeCanaryDispatchEnvelope(dispatch)),
					prompt: "must never enter SQS",
				}),
			),
		).toThrow("invalid AgentCore dispatch envelope");
		expect(() =>
			parseCanaryDispatchEnvelope(
				JSON.stringify({
					...JSON.parse(serializeCanaryDispatchEnvelope(dispatch)),
					runtimeSessionId: "another-session",
				}),
			),
		).toThrow("invalid AgentCore dispatch envelope");
	});
});

describe("Acquisition receipt", () => {
	it("strictly correlates a committed acquisition to its dispatch", () => {
		const receipt = createAcquisitionReceipt(
			dispatch,
			{
				disposition: "acquired",
				owner: {
					userId: dispatch.userId,
					conversationId: dispatch.conversationId,
					epoch: 7,
				},
				workerId: "boot-1/invocation-9",
			},
			new Date("2026-08-14T16:01:00.000Z"),
		);

		expect(parseAcquisitionReceipt(JSON.stringify(receipt))).toEqual({
			schemaVersion: 1,
			dispatchId: dispatch.dispatchId,
			campaignId: dispatch.campaignId,
			scenarioId: dispatch.scenarioId,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
			expectedExecutionLane: "agentcore_canary",
			disposition: "acquired",
			ownershipEpoch: 7,
			workerId: "boot-1/invocation-9",
			committedAt: "2026-08-14T16:01:00.000Z",
		});
		expect(() =>
			parseAcquisitionReceipt(
				JSON.stringify({
					...receipt,
					runtimeSessionId: "another-session",
				}),
			),
		).toThrow("invalid AgentCore Acquisition receipt");
	});
});
