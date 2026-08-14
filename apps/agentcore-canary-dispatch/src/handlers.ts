import { z } from "zod";
import type { CanarySqsBatchResponse, CanarySqsEvent } from "./consumer";
import { CANARY_QUEUE_INVARIANTS } from "./invariants";
import type { CanaryPublishResult } from "./publisher";

const boundedIdentifier = z.string().trim().min(1).max(500);
const sqsEventSchema = z.object({
	Records: z
		.array(
			z.object({
				messageId: boundedIdentifier,
				body: z.string(),
			}),
		)
		.length(CANARY_QUEUE_INVARIANTS.consumerBatchSize),
});
const manualReplaySchema = z.strictObject({
	dispatchId: boundedIdentifier,
	requestedBy: boundedIdentifier,
});

export interface LambdaContext {
	awsRequestId: string;
}

function requireRequestId(context: LambdaContext): string {
	if (!context.awsRequestId || context.awsRequestId.trim() === "") {
		throw new Error("Lambda request identity is required");
	}
	return context.awsRequestId;
}

export function createCanaryPublisherHandler(options: {
	publish(publisherId: string): Promise<CanaryPublishResult>;
}) {
	return async (_event: unknown, context: LambdaContext) =>
		await options.publish(`lambda/${requireRequestId(context)}`);
}

export function createCanaryConsumerHandler(consumer: {
	handle(event: CanarySqsEvent): Promise<CanarySqsBatchResponse>;
}) {
	return async (event: unknown): Promise<CanarySqsBatchResponse> => {
		const parsed = sqsEventSchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid Canary SQS event");
		return await consumer.handle({
			Records: parsed.data.Records.map(({ messageId, body }) => ({
				messageId,
				body,
			})),
		});
	};
}

export function createManualReplayHandler(options: {
	replay(input: { dispatchId: string; requestedBy: string }): Promise<boolean>;
	publish(
		publisherId: string,
		dispatchId?: string,
	): Promise<CanaryPublishResult>;
}) {
	return async (event: unknown, context: LambdaContext) => {
		const parsed = manualReplaySchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid manual replay request");
		const eligible = await options.replay(parsed.data);
		if (!eligible)
			throw new Error("Canary dispatch is not eligible for replay");
		const publication = await options.publish(
			`manual-replay/${requireRequestId(context)}`,
			parsed.data.dispatchId,
		);
		const replayed =
			publication.publishedDispatchIds.includes(parsed.data.dispatchId) ||
			publication.ambiguousDispatchIds.includes(parsed.data.dispatchId);
		return { replayed, deferred: !replayed, publication };
	};
}
