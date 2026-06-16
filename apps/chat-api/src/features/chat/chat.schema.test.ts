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

	it("accepts a generated uuid-shaped conversationId", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			conversationId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
		});
		expect(result.success).toBe(true);
	});

	it("rejects a conversationId with path-unsafe characters", () => {
		// Must match the sandbox-daemon path-segment contract; a `.`, space, `/`,
		// or `..` here would otherwise fail deeper in the daemon after a sandbox
		// is created.
		for (const conversationId of [
			"conv.1",
			"my thread",
			"a/b",
			"../escape",
			"conv#1",
		]) {
			const result = ChatBodyRequest.safeParse({
				chatContent: "hello",
				conversationId,
			});
			expect(result.success).toBe(false);
		}
	});

	it("rejects a conversationId longer than 128 chars", () => {
		const result = ChatBodyRequest.safeParse({
			chatContent: "hello",
			conversationId: "a".repeat(129),
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
