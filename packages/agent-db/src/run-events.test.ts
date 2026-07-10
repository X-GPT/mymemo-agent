import { describe, expect, it } from "bun:test";
import { isAssistantTextPayload } from "./run-events";

describe("isAssistantTextPayload", () => {
	it("accepts only the authoritative complete-message payload", () => {
		expect(
			isAssistantTextPayload({ messageId: "message-1", text: "hello" }),
		).toBe(true);
		expect(isAssistantTextPayload({ text: "legacy" })).toBe(false);
		expect(isAssistantTextPayload({ messageId: 1, text: "hello" })).toBe(false);
		expect(isAssistantTextPayload({ messageId: "", text: "hello" })).toBe(
			false,
		);
		expect(isAssistantTextPayload({ messageId: "message-1", text: "" })).toBe(
			false,
		);
		expect(isAssistantTextPayload(null)).toBe(false);
	});
});
