import type {
	AcquireCanaryDispatchResult,
	CanaryDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const dispatchIdentityShape = {
	schemaVersion: z.literal(1),
	dispatchId: nonEmptyString,
	campaignId: nonEmptyString,
	scenarioId: nonEmptyString,
	userId: nonEmptyString,
	conversationId: nonEmptyString,
	runId: nonEmptyString,
	runtimeSessionId: nonEmptyString,
	expectedExecutionLane: z.literal("agentcore_canary"),
} as const;

const dispatchEnvelopeSchema = z
	.strictObject({
		...dispatchIdentityShape,
		admittedAt: z.iso.datetime(),
	})
	.refine((value) => value.runtimeSessionId === value.conversationId, {
		message: "Runtime session mismatch",
	});

const acquisitionReceiptSchema = z
	.strictObject({
		...dispatchIdentityShape,
		disposition: z.enum([
			"acquired",
			"already_acquired",
			"terminal",
			"temporarily_unavailable",
			"invalid_dispatch",
		]),
		ownershipEpoch: z.number().int().positive().nullable(),
		workerId: nonEmptyString.nullable(),
		committedAt: z.iso.datetime(),
	})
	.superRefine((value, context) => {
		if (value.runtimeSessionId !== value.conversationId) {
			context.addIssue({ code: "custom", message: "Runtime session mismatch" });
		}
		const owns =
			value.disposition === "acquired" ||
			value.disposition === "already_acquired";
		if (owns !== (value.ownershipEpoch !== null && value.workerId !== null)) {
			context.addIssue({
				code: "custom",
				message: "Ownership proof does not match disposition",
			});
		}
	});

export type AcquisitionReceipt = z.infer<typeof acquisitionReceiptSchema>;

function parseJson(value: string, description: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new Error(`invalid ${description}`);
	}
}

export function serializeCanaryDispatchEnvelope(
	dispatch: CanaryDispatchIdentity,
): string {
	return JSON.stringify({
		...dispatch,
		admittedAt: dispatch.admittedAt.toISOString(),
	});
}

export function parseCanaryDispatchEnvelope(
	value: string,
): CanaryDispatchIdentity {
	const parsed = dispatchEnvelopeSchema.safeParse(
		parseJson(value, "AgentCore dispatch envelope"),
	);
	if (!parsed.success) {
		throw new Error("invalid AgentCore dispatch envelope");
	}
	return { ...parsed.data, admittedAt: new Date(parsed.data.admittedAt) };
}

/** Constructed by the Runtime boundary only after acquisition transaction return. */
export function createAcquisitionReceipt(
	dispatch: CanaryDispatchIdentity,
	result: AcquireCanaryDispatchResult,
	committedAt = new Date(),
): AcquisitionReceipt {
	const owns =
		result.disposition === "acquired" ||
		result.disposition === "already_acquired";
	return {
		schemaVersion: 1,
		dispatchId: dispatch.dispatchId,
		campaignId: dispatch.campaignId,
		scenarioId: dispatch.scenarioId,
		userId: dispatch.userId,
		conversationId: dispatch.conversationId,
		runId: dispatch.runId,
		runtimeSessionId: dispatch.runtimeSessionId,
		expectedExecutionLane: dispatch.expectedExecutionLane,
		disposition: result.disposition,
		ownershipEpoch: owns ? result.owner.epoch : null,
		workerId: owns ? result.workerId : null,
		committedAt: committedAt.toISOString(),
	};
}

export function parseAcquisitionReceipt(value: string): AcquisitionReceipt {
	const parsed = acquisitionReceiptSchema.safeParse(
		parseJson(value, "AgentCore Acquisition receipt"),
	);
	if (!parsed.success) {
		throw new Error("invalid AgentCore Acquisition receipt");
	}
	return parsed.data;
}

export function receiptCorrelatesDispatch(
	receipt: AcquisitionReceipt,
	dispatch: CanaryDispatchIdentity,
): boolean {
	return (
		receipt.dispatchId === dispatch.dispatchId &&
		receipt.campaignId === dispatch.campaignId &&
		receipt.scenarioId === dispatch.scenarioId &&
		receipt.userId === dispatch.userId &&
		receipt.conversationId === dispatch.conversationId &&
		receipt.runId === dispatch.runId &&
		receipt.runtimeSessionId === dispatch.runtimeSessionId &&
		receipt.expectedExecutionLane === dispatch.expectedExecutionLane
	);
}
