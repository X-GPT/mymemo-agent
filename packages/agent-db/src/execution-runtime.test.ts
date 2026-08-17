import { describe, expect, it } from "bun:test";
import {
	CONVERSATION_EXECUTION_RUNTIMES,
	requireConversationExecutionRuntime,
} from "./execution-runtime";

describe("Conversation execution runtime vocabulary", () => {
	it("accepts the shared legal values", () => {
		expect(
			CONVERSATION_EXECUTION_RUNTIMES.map(requireConversationExecutionRuntime),
		).toEqual(["fargate", "agentcore"]);
	});

	it("fails closed for retired and unknown values at application boundaries", () => {
		for (const value of ["agentcore_canary", "unknown", "", null, undefined]) {
			expect(() => requireConversationExecutionRuntime(value)).toThrow(
				"Unknown Conversation execution runtime",
			);
		}
	});
});
