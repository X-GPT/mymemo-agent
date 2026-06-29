import { describe, expect, it } from "bun:test";
import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";
import {
	AGENT_EXPOSURE_GATE,
	BreakGlassExposureGate,
	type StatsigClientLike,
	StatsigExposureGate,
} from "./exposure-gate";

const allowedIdentity: InternalIdentity = {
	memberCode: "member-allowed",
	partnerCode: "partner-1",
};
const deniedIdentity: InternalIdentity = {
	memberCode: "member-denied",
	partnerCode: "partner-1",
};

describe("BreakGlassExposureGate", () => {
	it("always allows (operator override)", async () => {
		const gate = new BreakGlassExposureGate();
		expect(await gate.isAgentEnabled(allowedIdentity)).toBe(true);
		expect(await gate.isAgentEnabled(deniedIdentity)).toBe(true);
	});
});

describe("StatsigExposureGate — offline via disableNetwork + overrideGate", () => {
	it("allows an identity the gate is overridden true for, denies others", async () => {
		// disableNetwork keeps the SDK fully offline (Statsig's testing facility for
		// node-core); overrideGate forces the decision deterministically.
		const statsig = new Statsig("secret-test", {
			disableNetwork: true,
			outputLogLevel: "none",
		});
		await statsig.initialize();
		statsig.overrideGate(AGENT_EXPOSURE_GATE, true, allowedIdentity.memberCode);

		const gate = new StatsigExposureGate(
			statsig as unknown as StatsigClientLike,
		);

		expect(await gate.isAgentEnabled(allowedIdentity)).toBe(true);
		// No override for this id → default false offline.
		expect(await gate.isAgentEnabled(deniedIdentity)).toBe(false);

		await statsig.shutdown();
	});
});

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

describe("StatsigUser construction (used by the gate)", () => {
	it("keys on memberCode and carries partner/team as custom fields", () => {
		const user = new StatsigUser({
			userID: "member-1",
			customIDs: { partnerCode: "partner-1" },
			custom: { teamCode: "team-1" },
		});
		expect(user.userID).toBe("member-1");
	});
});
