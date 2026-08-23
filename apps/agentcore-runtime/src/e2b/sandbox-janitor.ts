import { Sandbox } from "e2b";

export interface SandboxJanitor {
	killSandbox(sandboxId: string): Promise<void>;
}

export function createE2bSandboxJanitor(apiKey: string): SandboxJanitor {
	const options = { apiKey };
	return {
		async killSandbox(sandboxId): Promise<void> {
			await Sandbox.kill(sandboxId, options);
		},
	};
}
