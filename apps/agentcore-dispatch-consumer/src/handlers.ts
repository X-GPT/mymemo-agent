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

export function createAgentCoreConsumerHandler(consumer: {
	handle(event: AgentCoreSqsEvent): Promise<AgentCoreSqsBatchResponse>;
}) {
	return async (event: unknown): Promise<AgentCoreSqsBatchResponse> => {
		const parsed = sqsEventSchema.safeParse(event);
		if (!parsed.success) throw new Error("invalid AgentCore SQS event");
		return await consumer.handle(parsed.data);
	};
}
