import { describe, expect, it } from "bun:test";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";
import {
	AGENT_EXPOSURE_GATE,
	type StatsigClientLike,
	StatsigExposureGate,
} from "./exposure-gate";

const allowedIdentity: InternalIdentity = {
	memberCode: "member-allowed",
	partnerCode: "partner-1",
};
describe("StatsigExposureGate — fail closed", () => {
	it("denies when initialization fails", async () => {
		const client: StatsigClientLike = {
			initialize: () => Promise.reject(new Error("statsig down")),
			checkGate: () => true, // would allow, but init failed
		};
		const gate = new StatsigExposureGate(client);
		expect(await gate.isAgentEnabled(allowedIdentity)).toBe(false);
	});

	it("denies when checkGate throws", async () => {
		const client: StatsigClientLike = {
			initialize: () => Promise.resolve(),
			checkGate: () => {
				throw new Error("evaluation error");
			},
		};
		const gate = new StatsigExposureGate(client);
		expect(await gate.isAgentEnabled(allowedIdentity)).toBe(false);
	});

	it("evaluates from identity, building a StatsigUser keyed on memberCode", async () => {
		const seen: Array<{ userID: string | null; gate: string }> = [];
		const client: StatsigClientLike = {
			initialize: () => Promise.resolve(),
			checkGate: (user, gate) => {
				seen.push({ userID: user.userID, gate });
				return true;
			},
		};
		const gate = new StatsigExposureGate(client);
		await gate.isAgentEnabled(allowedIdentity);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.userID).toBe("member-allowed");
		expect(seen[0]?.gate).toBe(AGENT_EXPOSURE_GATE);
	});
});
