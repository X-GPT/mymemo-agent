import { describe, expect, it } from "bun:test";
import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { createCanaryDispatchPublisher } from "./publisher";

const dispatch: CanaryDispatchIdentity = {
	schemaVersion: 1,
	dispatchId: "dispatch-450",
	campaignId: "campaign-450",
	scenarioId: "baseline-v1",
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	expectedExecutionLane: "agentcore_canary",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

describe("Canary dispatch publisher", () => {
	it("fails closed before claiming or sending when the SSM control is disabled", async () => {
		const calls: string[] = [];
		const publisher = createCanaryDispatchPublisher({
			publisherId: "publisher-1",
			control: {
				isEnabled: async () => {
					calls.push("control");
					return false;
				},
			},
			store: {
				markOverdue: async () => {
					calls.push("overdue");
					return { campaignIds: [] };
				},
				claim: async () => {
					calls.push("claim");
					return [dispatch];
				},
				confirm: async () => {
					calls.push("confirm");
					return true;
				},
			},
			queue: {
				send: async () => {
					calls.push("send");
				},
			},
		});

		await expect(publisher.publishPending()).resolves.toEqual({
			status: "disabled",
			overdueCampaignIds: [],
			publishedDispatchIds: [],
			ambiguousDispatchIds: [],
		});
		expect(calls).toEqual(["control"]);
	});

	it("confirms a successful SQS send only after the leased claim returns", async () => {
		const calls: string[] = [];
		const publisher = createCanaryDispatchPublisher({
			publisherId: "publisher-1",
			control: { isEnabled: async () => true },
			store: {
				markOverdue: async () => ({ campaignIds: [] }),
				claim: async ({ dispatchId, limit }) => {
					calls.push(`claim-committed:${dispatchId}:${limit}`);
					return [dispatch];
				},
				confirm: async () => {
					calls.push("confirm");
					return true;
				},
			},
			queue: {
				send: async () => {
					calls.push("send");
				},
			},
		});

		await expect(
			publisher.publishPending({ dispatchId: dispatch.dispatchId }),
		).resolves.toEqual({
			status: "enabled",
			overdueCampaignIds: [],
			publishedDispatchIds: [dispatch.dispatchId],
			ambiguousDispatchIds: [],
		});
		expect(calls).toEqual([
			`claim-committed:${dispatch.dispatchId}:10`,
			"send",
			"confirm",
		]);
	});

	it("leaves an ambiguous SQS send leased for later exact replay", async () => {
		let confirmed = false;
		const publisher = createCanaryDispatchPublisher({
			publisherId: "publisher-1",
			control: { isEnabled: async () => true },
			store: {
				markOverdue: async () => ({ campaignIds: [] }),
				claim: async () => [dispatch],
				confirm: async () => {
					confirmed = true;
					return true;
				},
			},
			queue: {
				send: async () => {
					throw new Error("connection closed after send");
				},
			},
		});

		await expect(publisher.publishPending()).resolves.toMatchObject({
			publishedDispatchIds: [],
			ambiguousDispatchIds: [dispatch.dispatchId],
		});
		expect(confirmed).toBe(false);
	});
});
