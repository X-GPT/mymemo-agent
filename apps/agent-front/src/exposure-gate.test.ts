import { expect, test } from "bun:test";
import { AGENT_EXPOSURE_GATE, StatsigExposureGate } from "./exposure-gate";

const identity = {
	memberCode: "member",
	partnerCode: "partner",
	teamCode: "team",
};
test("Statsig initialization and evaluation fail closed", async () => {
	for (const initialize of [
		() => Promise.reject(new Error("unreachable")),
		async () => ({ isSuccess: false }),
	]) {
		const gate = new StatsigExposureGate({ initialize, checkGate: () => true });
		expect(await gate.isAgentEnabled(identity)).toBe(false);
	}
	const gate = new StatsigExposureGate({
		initialize: async () => ({ isSuccess: true }),
		checkGate: () => {
			throw new Error("unreachable");
		},
	});
	expect(await gate.isAgentEnabled(identity)).toBe(false);
});
test("Statsig receives v1 member, partner and team identity", async () => {
	const gate = new StatsigExposureGate({
		initialize: async () => ({ isSuccess: true }),
		checkGate: (user, name) => {
			expect(user.userID).toBe(identity.memberCode);
			expect(user.customIDs).toEqual({ partnerCode: identity.partnerCode });
			expect(user.custom).toEqual({
				partnerCode: identity.partnerCode,
				teamCode: identity.teamCode,
			});
			expect(name).toBe(AGENT_EXPOSURE_GATE);
			return true;
		},
	});
	expect(await gate.isAgentEnabled(identity)).toBe(true);
});
