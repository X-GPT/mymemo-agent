import {
	SendMessageCommand,
	type SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { serializeAgentCoreDispatchEnvelope } from "./envelope";
import type { AgentCoreDispatchQueue } from "./publisher";

interface SqsCommandClient {
	send(
		command: SendMessageCommand,
	): Promise<Pick<SendMessageCommandOutput, "MessageId">>;
}

export function createSqsAgentCoreDispatchQueue(options: {
	client: SqsCommandClient;
	queueUrl: string;
}): AgentCoreDispatchQueue {
	return {
		async send(dispatch): Promise<void> {
			await options.client.send(
				new SendMessageCommand({
					QueueUrl: options.queueUrl,
					MessageBody: serializeAgentCoreDispatchEnvelope(dispatch),
				}),
			);
		},
	};
}
