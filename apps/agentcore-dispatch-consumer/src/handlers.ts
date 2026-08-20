import type { AgentCoreDispatchPublishResult } from "@mymemo/agentcore-dispatch/publisher";
import { z } from "zod";
import type { AgentCoreSqsBatchResponse, AgentCoreSqsEvent } from "./consumer";
import { AGENTCORE_DISPATCH_QUEUE_INVARIANTS } from "./invariants";

const boundedIdentifier = z.string().trim().min(1).max(500);
const sqsEventSchema = z.object({
	Records: z
		.array(
			z.object({
				messageId: boundedIdentifier,
				body: z.string(),
			}),
		)
		.length(AGENTCORE_DISPATCH_QUEUE_INVARIANTS.consumerBatchSize),
});
const manualReplaySchema = z.strictObject({
	runId: boundedIdentifier,
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

export function createAgentCorePublisherHandler(options: {
	publish(publisherId: string): Promise<AgentCoreDispatchPublishResult>;
}) {
	return async (_event: unknown, context: LambdaContext) =>
		await options.publish(`lambda/${requireRequestId(context)}`);
}

export function createAgentCoreConsumerHandler(consumer: {
	handle(event: AgentCoreSqsEvent): Promise<AgentCoreSqsBatchResponse>;
}) {
	return async (event: unknown): Promise<AgentCoreSqsBatchResponse> => {
		const parsed = sqsEventSchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid AgentCore SQS event");
		return await consumer.handle(parsed.data);
	};
}

export function createManualReplayHandler(options: {
	replay(input: { runId: string; requestedBy: string }): Promise<boolean>;
	publish(
		publisherId: string,
		runId?: string,
	): Promise<AgentCoreDispatchPublishResult>;
}) {
	return async (event: unknown, context: LambdaContext) => {
		const parsed = manualReplaySchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid manual replay request");
		const eligible = await options.replay(parsed.data);
		if (!eligible)
			throw new Error("AgentCore dispatch is not eligible for replay");
		const publication = await options.publish(
			`manual-replay/${requireRequestId(context)}`,
			parsed.data.runId,
		);
		const replayed =
			publication.publishedRunIds.includes(parsed.data.runId) ||
			publication.ambiguousRunIds.includes(parsed.data.runId);
		return { replayed, deferred: !replayed, publication };
	};
}
