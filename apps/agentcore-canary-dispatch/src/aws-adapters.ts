import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import {
	SendMessageCommand,
	type SendMessageCommandOutput,
} from "@aws-sdk/client-sqs";
import {
	GetParameterCommand,
	type GetParameterCommandOutput,
} from "@aws-sdk/client-ssm";
import {
	claimAgentCoreDispatchesTx,
	confirmAgentCoreDispatchPublishedTx,
} from "@mymemo/agent-db/canary-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import type { AgentCoreRuntimeInvoker } from "./consumer";
import { serializeCanaryDispatchEnvelope } from "./contract";
import type {
	CanaryDispatchPublisherStore,
	CanaryDispatchQueue,
	CanaryEnablementControl,
} from "./publisher";

interface SsmCommandClient {
	send(
		command: GetParameterCommand,
	): Promise<Pick<GetParameterCommandOutput, "Parameter">>;
}

interface SqsCommandClient {
	send(
		command: SendMessageCommand,
	): Promise<Pick<SendMessageCommandOutput, "MessageId">>;
}

interface AgentCoreCommandClient {
	send(command: InvokeAgentRuntimeCommand): Promise<{ response?: unknown }>;
}

export function createSsmCanaryEnablementControl(options: {
	client: SsmCommandClient;
	parameterName: string;
}): CanaryEnablementControl {
	return {
		async isEnabled(): Promise<boolean> {
			const result = await options.client.send(
				new GetParameterCommand({
					Name: options.parameterName,
					WithDecryption: false,
				}),
			);
			return result.Parameter?.Value === "enabled";
		},
	};
}

export function createSqsCanaryDispatchQueue(options: {
	client: SqsCommandClient;
	queueUrl: string;
}): CanaryDispatchQueue {
	return {
		async send(dispatch): Promise<void> {
			await options.client.send(
				new SendMessageCommand({
					QueueUrl: options.queueUrl,
					MessageBody: serializeCanaryDispatchEnvelope(dispatch),
				}),
			);
		},
	};
}

export function createDatabaseCanaryDispatchPublisherStore(options: {
	db: Database;
	now?: () => Date;
}): CanaryDispatchPublisherStore {
	const now = options.now ?? (() => new Date());
	return {
		claim: async ({ publisherId, runId, limit }) =>
			await claimAgentCoreDispatchesTx(options.db, {
				publisherId,
				runId,
				limit,
				now: now(),
			}),
		confirm: async ({ runId, publisherId }) =>
			await confirmAgentCoreDispatchPublishedTx(options.db, {
				runId,
				publisherId,
				now: now(),
			}),
	};
}

function asReceiptStream(value: unknown): AsyncIterable<Uint8Array> {
	if (
		typeof value !== "object" ||
		value === null ||
		!(Symbol.asyncIterator in value)
	) {
		throw new Error("AgentCore Runtime returned no streaming response");
	}
	return value as AsyncIterable<Uint8Array>;
}

export function createBedrockAgentCoreRuntimeInvoker(options: {
	client: AgentCoreCommandClient;
	agentRuntimeArn: string;
}): AgentCoreRuntimeInvoker {
	return {
		async invoke(dispatch) {
			const result = await options.client.send(
				new InvokeAgentRuntimeCommand({
					agentRuntimeArn: options.agentRuntimeArn,
					runtimeSessionId: dispatch.runtimeSessionId,
					payload: new TextEncoder().encode(
						serializeCanaryDispatchEnvelope(dispatch),
					),
					contentType: "application/json",
					accept: "application/x-ndjson",
					qualifier: "DEFAULT",
				}),
			);
			const response = result.response;
			const chunks = asReceiptStream(response);
			return {
				chunks,
				async close() {
					if (typeof response !== "object" || response === null) return;
					const closable = response as {
						destroy?: () => void;
						cancel?: () => void | Promise<void>;
					};
					if (typeof closable.destroy === "function") {
						closable.destroy();
						return;
					}
					if (typeof closable.cancel === "function") {
						await closable.cancel();
					}
				},
			};
		},
	};
}
