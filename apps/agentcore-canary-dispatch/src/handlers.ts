import { z } from "zod";
import type { CanarySqsBatchResponse, CanarySqsEvent } from "./consumer";

const nonEmptyString = z.string().trim().min(1).max(500);
const sqsEventSchema = z.object({
	Records: z.array(
		z.object({
			messageId: nonEmptyString,
			body: z.string(),
		}),
	),
});
const manualReplaySchema = z.strictObject({
	dispatchId: nonEmptyString,
	requestedBy: nonEmptyString,
});

interface LambdaContext {
	awsRequestId: string;
}

function requireRequestId(context: LambdaContext): string {
	if (!context.awsRequestId || context.awsRequestId.trim() === "") {
		throw new Error("Lambda request identity is required");
	}
	return context.awsRequestId;
}

export function createCanaryPublisherHandler(options: {
	publish(publisherId: string): Promise<unknown>;
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
	publish(publisherId: string): Promise<unknown>;
}) {
	return async (event: unknown, context: LambdaContext) => {
		const parsed = manualReplaySchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid manual replay request");
		const replayed = await options.replay(parsed.data);
		if (!replayed) throw new Error("Canary dispatch was not found");
		const publication = await options.publish(
			`manual-replay/${requireRequestId(context)}`,
		);
		return { replayed, publication };
	};
}
