import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import { serializeAgentCoreDispatchEnvelope } from "./envelope";

describe("AgentCore dispatch envelope", () => {
	it("serializes only the strict version-2 dispatch identity", () => {
		const dispatch: AgentCoreDispatchIdentity & { prompt: string } = {
			schemaVersion: 2,
			userId: "service-user",
			conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			runId: "run-450",
			runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
			admittedAt: new Date("2026-08-14T16:00:00.000Z"),
			prompt: "must never enter SQS",
		};

		expect(JSON.parse(serializeAgentCoreDispatchEnvelope(dispatch))).toEqual({
			schemaVersion: 2,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
			admittedAt: "2026-08-14T16:00:00.000Z",
		});
	});
});
