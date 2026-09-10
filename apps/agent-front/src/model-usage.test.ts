import { expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
	GetObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import { HistoryStore, type Turn, turnMetadata } from "./history";
import type { Conversation } from "./store";
import { createTextStream, type TextStreamChunk } from "./text-stream";

const reported = {
	inputTokens: 12,
	outputTokens: 34,
	cacheReadInputTokens: 56,
	cacheCreationInputTokens: 78,
	webSearchRequests: 1,
	costUSD: 0.0123,
	contextWindow: 200000,
	maxOutputTokens: 64000,
	canonicalModel: "claude-sonnet-4-6",
	provider: "bedrock",
	costBasis: "list" as const,
};
const modelUsage = {
	"provider.model-alias": reported,
	"claude-haiku-4-5": { ...reported, inputTokens: 9, costUSD: 0 },
};
function harness(model?: string) {
	const chunks: TextStreamChunk[] = [];
	return {
		chunks,
		...createTextStream({
			messageId: "assistant",
			turnId: "turn",
			requestId: "request",
			startedAt: "2026-09-09T00:00:00.000Z",
			...(model ? { model } : {}),
			emit: (chunk) => chunks.push(chunk),
		}),
	};
}

test("terminal model usage survives final metadata and whole-Turn history on done and error", async () => {
	const s3 = new S3Client({ region: "us-west-2" });
	let body = "";
	const send = spyOn(s3, "send").mockImplementation(async (command) => {
		if (command instanceof PutObjectCommand) {
			body = String(command.input.Body);
			return {};
		}
		assert(command instanceof GetObjectCommand);
		return { Body: { transformToString: async () => body } };
	});
	try {
		const history = new HistoryStore(s3, "history");
		const conversation = {
			conversationId: "conversation",
			turnCount: 1,
		} as Conversation;
		for (const mode of [
			"done",
			"error-result",
			"runtime-error",
			"later-failure",
			"missing",
		] as const) {
			const h = harness();
			h.push({
				type: "assistant",
				message: { usage: { input_tokens: 999 }, content: [] },
			});
			h.push({
				type: "result",
				subtype: mode === "error-result" ? "error_during_execution" : "success",
				is_error: mode === "error-result",
				...(mode === "missing" ? {} : { modelUsage }),
			});
			if (mode === "runtime-error")
				h.push({ type: "mymemo.error", code: "internal_error" });
			const assistant = h.finish(
				mode === "later-failure" ? "workspace_too_large" : undefined,
			);
			const expected = mode === "missing" ? undefined : modelUsage;
			expect(assistant.metadata.modelUsage).toEqual(expected);
			expect(assistant.metadata.status).toBe(
				["done", "missing"].includes(mode) ? "done" : "error",
			);
			expect(h.chunks.at(-2)).toEqual({
				type: "message-metadata",
				messageMetadata: assistant.metadata,
			});
			expect(h.chunks[0]).not.toHaveProperty("messageMetadata.modelUsage");
			const turn: Turn = {
				...assistant.metadata,
				seq: 1,
				user: {
					id: "user",
					role: "user",
					parts: [{ type: "text", text: "hello" }],
					metadata: assistant.metadata,
				},
				assistant,
			};
			await history.put(conversation.conversationId, turn);
			expect(
				(await history.get(conversation.conversationId, 1))?.modelUsage,
			).toEqual(expected);
			const page = await history.page(conversation, 1);
			expect(page.messages).toHaveLength(2);
			for (const message of page.messages)
				expect(message.metadata).toEqual(assistant.metadata);
			if (mode === "missing") expect(body).not.toContain("modelUsage");
		}
	} finally {
		send.mockRestore();
		s3.destroy();
	}
});

test("invalid or missing model usage is omitted without changing the outcome", () => {
	for (const invalid of [
		undefined,
		null,
		[],
		12,
		"usage",
		{ model: null },
		{ model: [] },
		{ model: {} },
		...Object.keys(reported).map((field) => ({
			model: { ...reported, [field]: null },
		})),
		{ model: { ...reported, inputTokens: -1 } },
		{ model: { ...reported, costUSD: Number.NaN } },
		{ model: { ...reported, outputTokens: Infinity } },
		{ model: { ...reported, inputTokens: "12" } },
		{ model: { ...reported, costBasis: "billing" } },
	]) {
		for (const subtype of ["success", "error_during_execution"]) {
			const h = harness();
			h.push({ type: "result", subtype, modelUsage: invalid });
			const message = h.finish();
			expect(message.metadata).not.toHaveProperty("modelUsage");
			expect(message.metadata.status).toBe(
				subtype === "success" ? "done" : "error",
			);
		}
	}
});

test("preserves empty usage, optional-field omissions and additional reported fields", () => {
	const { canonicalModel, provider, costBasis, ...required } = reported;
	for (const usage of [
		{},
		{ model: required },
		{ model: { ...reported, extra: 42 } },
	]) {
		const h = harness();
		h.push({ type: "result", subtype: "success", modelUsage: usage });
		expect(h.finish().metadata).toMatchObject({ modelUsage: usage });
	}
});

test("the requested Turn model reaches terminal metadata and whole-Turn history", async () => {
	const s3 = new S3Client({ region: "us-west-2" });
	let body = "";
	const send = spyOn(s3, "send").mockImplementation(async (command) => {
		if (command instanceof PutObjectCommand) {
			body = String(command.input.Body);
			return {};
		}
		assert(command instanceof GetObjectCommand);
		return { Body: { transformToString: async () => body } };
	});
	try {
		const history = new HistoryStore(s3, "history");
		const conversation = {
			conversationId: "conversation",
			turnCount: 1,
		} as Conversation;
		for (const model of ["deepseek/deepseek-v4-pro", undefined]) {
			const h = harness(model);
			h.push({ type: "result", subtype: "success", modelUsage });
			const assistant = h.finish();
			// The model requested for the Turn, not a name reported in usage.
			expect(assistant.metadata.model).toBe(model);
			expect(assistant.metadata.modelUsage).toEqual(modelUsage);
			expect(h.chunks.at(-2)).toEqual({
				type: "message-metadata",
				messageMetadata: assistant.metadata,
			});
			const turn: Turn = {
				...assistant.metadata,
				seq: 1,
				user: {
					id: "user",
					role: "user",
					parts: [{ type: "text", text: "hello" }],
					metadata: assistant.metadata,
				},
				assistant,
			};
			await history.put(conversation.conversationId, turn);
			expect((await history.get(conversation.conversationId, 1))?.model).toBe(
				model,
			);
			const page = await history.page(conversation, 1);
			expect(page.messages).toHaveLength(2);
			for (const message of page.messages)
				expect(message.metadata.model).toBe(model);
			if (!model) expect(body).not.toContain('"model"');
		}
		// An abandoned Turn keeps the model it was submitted with.
		expect(
			turnMetadata(
				{
					turnId: "turn",
					requestId: "request",
					status: "processing",
					startedAt: "2026-09-09T00:00:00.000Z",
					model: "anthropic/claude-sonnet-5",
				},
				{ ...conversation, processing: undefined } as Conversation,
			),
		).toEqual({
			turnId: "turn",
			requestId: "request",
			status: "error",
			errorCode: "abandoned",
			startedAt: "2026-09-09T00:00:00.000Z",
			model: "anthropic/claude-sonnet-5",
		});
	} finally {
		send.mockRestore();
		s3.destroy();
	}
});
