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

test("initialization starts inside a gated request, not before Lambda can freeze", async () => {
	let calls = 0;
	let finish!: (result: { isSuccess: boolean }) => void;
	const gate = new StatsigExposureGate({
		initialize: () => {
			calls++;
			return new Promise((resolve) => {
				finish = resolve;
			});
		},
		checkGate: () => true,
	});
	expect(calls).toBe(0);
	const first = gate.isAgentEnabled(identity);
	const second = gate.isAgentEnabled(identity);
	expect(calls).toBe(1);
	finish({ isSuccess: true });
	expect(await Promise.all([first, second])).toEqual([true, true]);
	expect(await gate.isAgentEnabled(identity)).toBe(true);
	expect(calls).toBe(1);
});

test("failed initialization denies this request and retries on the next request", async () => {
	for (const fail of [
		async () => ({ isSuccess: false }),
		async (): Promise<{ isSuccess: boolean }> => {
			throw new Error("network");
		},
	]) {
		let calls = 0;
		const gate = new StatsigExposureGate({
			initialize: () =>
				++calls === 1 ? fail() : Promise.resolve({ isSuccess: true }),
			checkGate: () => true,
		});
		expect(await gate.isAgentEnabled(identity)).toBe(false);
		expect(await gate.isAgentEnabled(identity)).toBe(true);
		expect(calls).toBe(2);
	}
});
