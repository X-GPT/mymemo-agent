import {
	GetParameterCommand,
	type GetParameterCommandOutput,
} from "@aws-sdk/client-ssm";
import type { AgentCoreDispatchEnablementControl } from "./publisher";

interface SsmCommandClient {
	send(
		command: GetParameterCommand,
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
			);
			return result.Parameter?.Value === "enabled";
		},
	};
}
