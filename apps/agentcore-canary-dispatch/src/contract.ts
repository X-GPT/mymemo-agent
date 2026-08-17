import type {
	AcquireAgentCoreDispatchResult,
	AgentCoreDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import { z } from "zod";

const nonEmptyString = z.string().trim().min(1);

const dispatchIdentityShape = {
	schemaVersion: z.literal(2),
	userId: nonEmptyString,
	conversationId: nonEmptyString,
	runId: nonEmptyString,
	runtimeSessionId: nonEmptyString,
} as const;
const dispatchIdentityKeys = Object.keys(
	dispatchIdentityShape,
) as (keyof typeof dispatchIdentityShape)[];

const dispatchIdentitySchema = z
	.strictObject(dispatchIdentityShape)
	.refine((value) => value.runtimeSessionId === value.conversationId, {
		message: "Runtime session mismatch",
	});

const dispatchEnvelopeSchema = dispatchIdentitySchema.safeExtend({
	admittedAt: z.iso.datetime(),
});

const acquisitionReceiptSchema = dispatchIdentitySchema
	.safeExtend({
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
		const owns = isOwnershipDisposition(value.disposition);
		if (owns !== (value.ownershipEpoch !== null && value.workerId !== null)) {
			context.addIssue({
				code: "custom",
				message: "Ownership proof does not match disposition",
			});
		}
	});

export type AcquisitionReceipt = z.infer<typeof acquisitionReceiptSchema>;

export class InvalidCanaryDispatchEnvelopeError extends Error {
	override readonly name = "InvalidCanaryDispatchEnvelopeError";
}

function isOwnershipDisposition(
	disposition: AcquireAgentCoreDispatchResult["disposition"],
): disposition is "acquired" | "already_acquired" {
	return disposition === "acquired" || disposition === "already_acquired";
}

function hasOwnership(
	result: AcquireAgentCoreDispatchResult,
): result is Extract<
	AcquireAgentCoreDispatchResult,
	{ disposition: "acquired" | "already_acquired" }
> {
	return isOwnershipDisposition(result.disposition);
}

function parseJson(value: string, invalid: () => Error): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw invalid();
	}
}

export function serializeCanaryDispatchEnvelope(
	dispatch: AgentCoreDispatchIdentity,
): string {
	return JSON.stringify({
		schemaVersion: dispatch.schemaVersion,
		userId: dispatch.userId,
		conversationId: dispatch.conversationId,
		runId: dispatch.runId,
		runtimeSessionId: dispatch.runtimeSessionId,
		admittedAt: dispatch.admittedAt.toISOString(),
	});
}

export function parseCanaryDispatchEnvelope(
	value: string,
): AgentCoreDispatchIdentity {
	const invalid = () =>
		new InvalidCanaryDispatchEnvelopeError(
			"invalid AgentCore dispatch envelope",
		);
	const decoded = parseJson(value, invalid);
	const parsed = dispatchEnvelopeSchema.safeParse(decoded);
	if (!parsed.success) throw invalid();
	return { ...parsed.data, admittedAt: new Date(parsed.data.admittedAt) };
}

export function sameCanaryDispatch(
	left: AgentCoreDispatchIdentity,
	right: AgentCoreDispatchIdentity,
): boolean {
	return (
		dispatchIdentityKeys.every((key) => left[key] === right[key]) &&
		left.admittedAt.getTime() === right.admittedAt.getTime()
	);
}

/** Constructed by the Runtime boundary only after acquisition transaction return. */
export function createAcquisitionReceipt(
	dispatch: AgentCoreDispatchIdentity,
	result: AcquireAgentCoreDispatchResult,
	committedAt = new Date(),
): AcquisitionReceipt {
	const owns = hasOwnership(result);
	const { admittedAt: _admittedAt, ...identity } = dispatch;
	return {
		...identity,
		disposition: result.disposition,
		ownershipEpoch: owns ? result.owner.epoch : null,
		workerId: owns ? result.workerId : null,
		committedAt: committedAt.toISOString(),
	};
}

export function parseAcquisitionReceipt(value: string): AcquisitionReceipt {
	const parsed = acquisitionReceiptSchema.safeParse(
		parseJson(value, () => new Error("invalid AgentCore Acquisition receipt")),
	);
	if (!parsed.success) {
		throw new Error("invalid AgentCore Acquisition receipt");
	}
	return parsed.data;
}

export function receiptCorrelatesDispatch(
	receipt: AcquisitionReceipt,
	dispatch: AgentCoreDispatchIdentity,
): boolean {
	return dispatchIdentityKeys.every((key) => receipt[key] === dispatch[key]);
}
