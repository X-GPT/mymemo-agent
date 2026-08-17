import { describe, expect, it } from "bun:test";
import type { ApiConfig } from "@/config/env";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";
import { createRuntimeGate } from "./index";
import {
	AGENTCORE_RUNTIME_GATE,
	BreakGlassRuntimeGate,
	type StatsigClientLike,
	StatsigRuntimeGate,
} from "./runtime-gate";

const identity: InternalIdentity = {
	memberCode: "member-1",
	partnerCode: "partner-1",
	teamCode: "team-1",
};

describe("StatsigRuntimeGate", () => {
	it.each([
		[true, "agentcore"],
		[false, "fargate"],
	] as const)("selects the frozen execution runtime from a %s gate decision", async (decision, expectedRuntime) => {
		const seen: Array<{ userID: string | null; gate: string }> = [];
		const client: StatsigClientLike = {
			initialize: async () => {},
			checkGate: (user, gate) => {
				seen.push({ userID: user.userID, gate });
				return decision;
			},
		};

		const gate = new StatsigRuntimeGate(client);

		await expect(gate.selectRuntime(identity)).resolves.toBe(expectedRuntime);
		expect(seen).toEqual([
			{ userID: "member-1", gate: AGENTCORE_RUNTIME_GATE },
		]);
	});

	it.each([
		[
			"initialization failure",
			{
				initialize: async () => {
					throw new Error("Statsig unavailable");
				},
				checkGate: () => true,
			} satisfies StatsigClientLike,
		],
		[
			"evaluation failure",
			{
				initialize: async () => {},
				checkGate: () => {
					throw new Error("evaluation failed");
				},
			} satisfies StatsigClientLike,
		],
	] as const)("fails safe to Fargate on %s", async (_name, client) => {
		const gate = new StatsigRuntimeGate(client);

		await expect(gate.selectRuntime(identity)).resolves.toBe("fargate");
	});
});

describe("BreakGlassRuntimeGate", () => {
	it("always selects Fargate without consulting Statsig", async () => {
		const gate = new BreakGlassRuntimeGate();

		await expect(gate.selectRuntime(identity)).resolves.toBe("fargate");
	});

	it("is selected by break-glass configuration without a Statsig secret", async () => {
		const gate = createRuntimeGate({
			agentExposureBreakGlass: true,
			statsigServerSecret: undefined,
		} as ApiConfig);

		await expect(gate.selectRuntime(identity)).resolves.toBe("fargate");
	});
});
