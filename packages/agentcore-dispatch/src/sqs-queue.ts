import {
	SendMessageCommand,
	type SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import { serializeAgentCoreDispatchEnvelope } from "./envelope";
import type { AgentCoreDispatchQueue } from "./publisher";

const AWS_REQUEST_TIMEOUT_MS = 10_000;

interface SqsCommandClient {
	send(
		command: SendMessageCommand,
		options: { abortSignal: AbortSignal },
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
				{ abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) },
			);
		},
	};
}
