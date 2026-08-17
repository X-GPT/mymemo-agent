import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import { createCanaryDispatchPublisher } from "./publisher";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
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
			publishedRunIds: [],
			ambiguousRunIds: [],
		});
		expect(calls).toEqual(["control"]);
	});

	it("confirms a successful SQS send only after the leased claim returns", async () => {
		const calls: string[] = [];
		const publisher = createCanaryDispatchPublisher({
			publisherId: "publisher-1",
			control: { isEnabled: async () => true },
			store: {
				claim: async ({ runId, limit }) => {
					calls.push(`claim-committed:${runId}:${limit}`);
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
			publisher.publishPending({ runId: dispatch.runId }),
		).resolves.toEqual({
			status: "enabled",
			publishedRunIds: [dispatch.runId],
			ambiguousRunIds: [],
		});
		expect(calls).toEqual([
			`claim-committed:${dispatch.runId}:10`,
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
			publishedRunIds: [],
			ambiguousRunIds: [dispatch.runId],
		});
		expect(confirmed).toBe(false);
	});
});
