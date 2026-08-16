import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import {
	createAcquisitionReceipt,
	InvalidCanaryDispatchEnvelopeError,
	parseAcquisitionReceipt,
	parseCanaryDispatchEnvelope,
	sameCanaryDispatch,
	serializeCanaryDispatchEnvelope,
} from "./contract";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("Canary dispatch envelope", () => {
	it("round-trips only the strict version-2 Run identity and admission timestamp", () => {
		const wire = serializeCanaryDispatchEnvelope(dispatch);

		expect(JSON.parse(wire)).toEqual({
			schemaVersion: 2,
			userId: "canary-service-user",
			conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			runId: "run-450",
			runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			admittedAt: "2026-08-14T16:00:00.000Z",
		});
		expect(parseCanaryDispatchEnvelope(wire)).toEqual(dispatch);
	});

	it("omits runtime-only properties before writing the content-free envelope", () => {
		const runtimeDispatch = {
			...dispatch,
			prompt: "must never enter SQS",
		};

		expect(
			JSON.parse(serializeCanaryDispatchEnvelope(runtimeDispatch)),
		).not.toHaveProperty("prompt");
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

	it("rejects version 1, extra content, and a Runtime session that does not name the Conversation", () => {
		expect(() =>
			parseCanaryDispatchEnvelope(
				JSON.stringify({
					...JSON.parse(serializeCanaryDispatchEnvelope(dispatch)),
					schemaVersion: 1,
				}),
			),
		).toThrow("invalid AgentCore dispatch envelope");
		expect(() =>
			parseCanaryDispatchEnvelope(
				JSON.stringify({
					...JSON.parse(serializeCanaryDispatchEnvelope(dispatch)),
					prompt: "must never enter SQS",
				}),
			),
		).toThrow("invalid AgentCore dispatch envelope");
		expect(() => parseCanaryDispatchEnvelope("not-json")).toThrow(
			InvalidCanaryDispatchEnvelopeError,
		);
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
			schemaVersion: 2,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
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
