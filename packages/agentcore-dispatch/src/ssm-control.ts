import {
	GetParameterCommand,
	type GetParameterCommandOutput,
} from "@aws-sdk/client-ssm";
import type { AgentCoreDispatchEnablementControl } from "./publisher";

const AWS_REQUEST_TIMEOUT_MS = 10_000;

interface SsmCommandClient {
	send(
		command: GetParameterCommand,
		options: { abortSignal: AbortSignal },
	): Promise<Pick<GetParameterCommandOutput, "Parameter">>;
}

export function createSsmAgentCoreDispatchEnablementControl(options: {
	client: SsmCommandClient;
	parameterName: string;
}): AgentCoreDispatchEnablementControl {
	return {
		async isEnabled(): Promise<boolean> {
			const result = await options.client.send(
				new GetParameterCommand({
					Name: options.parameterName,
					WithDecryption: false,
				}),
				{ abortSignal: AbortSignal.timeout(AWS_REQUEST_TIMEOUT_MS) },
			);
			return result.Parameter?.Value === "enabled";
		},
	};
}
