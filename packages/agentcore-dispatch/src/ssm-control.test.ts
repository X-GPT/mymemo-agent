import { describe, expect, it } from "bun:test";
import { createSsmAgentCoreDispatchEnablementControl } from "./ssm-control";

describe("SSM AgentCore dispatch enablement control", () => {
	it("enables dispatch only for the exact deployment-owned value", async () => {
		const values = ["enabled", "true", "ENABLED", undefined];
		const observed: boolean[] = [];
		for (const value of values) {
			const control = createSsmAgentCoreDispatchEnablementControl({
				parameterName: "/mymemo/agentcore-dispatch/enabled",
				client: {
					send: async (command, request) => {
						expect(command.input).toEqual({
							Name: "/mymemo/agentcore-dispatch/enabled",
							WithDecryption: false,
						});
						expect(request.abortSignal).toBeInstanceOf(AbortSignal);
						expect(request.abortSignal.aborted).toBe(false);
						return { Parameter: { Value: value } };
					},
				},
			});
			observed.push(await control.isEnabled());
		}

		expect(observed).toEqual([true, false, false, false]);
	});
});
