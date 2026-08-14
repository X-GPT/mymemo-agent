import { describe, expect, it } from "bun:test";
import {
	CONVERSATION_EXECUTION_LANES,
	requireConversationExecutionLane,
} from "./execution-lane";

describe("Conversation execution lane vocabulary", () => {
	it("accepts the shared legal values", () => {
		expect(
			CONVERSATION_EXECUTION_LANES.map(requireConversationExecutionLane),
		).toEqual(["fargate", "agentcore_canary"]);
	});

	it("fails closed for unknown values at application boundaries", () => {
		for (const value of ["agentcore", "unknown", "", null, undefined]) {
			expect(() => requireConversationExecutionLane(value)).toThrow(
				"Unknown Conversation execution lane",
			);
		}
	});
});
