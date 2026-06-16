import { describe, expect, it } from "bun:test";
import { ChatBodyRequest } from "./chat.schema";

describe("ChatBodyRequest", () => {
	it("accepts a minimal body without conversationId", () => {
		const result = ChatBodyRequest.safeParse({ chatContent: "hello" });
		expect(result.success).toBe(true);
	});

	it("accepts a body with conversationId", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			conversationId: "conv-123",
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.conversationId).toBe("conv-123");
		}
	});

	it("rejects a body containing sessionId", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			sessionId: "sess-123",
		});
		expect(result.success).toBe(false);
	});

	it("rejects an empty conversationId", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			conversationId: "",
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys (strict)", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			memberCode: "member-1",
		});
		expect(result.success).toBe(false);
	});

	it("still accepts collectionId and summaryId", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			collectionId: "col-1",
			summaryId: "sum-1",
		});
		expect(result.success).toBe(true);
	});
});
