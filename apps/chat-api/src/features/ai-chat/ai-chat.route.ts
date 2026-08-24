import { EventType } from "@ag-ui/core";
import { sValidator as zValidator } from "@hono/standard-validator";
import {
	isTerminalRunStatus,
	RunInputMismatchError,
	type RunRecord,
} from "@mymemo/agent-db/run-store";
import {
	decodeAgUiLiveStreamEvent,
	RUN_INTERRUPTED_EVENT_TYPE,
} from "@mymemo/live-text";
import {
	createUIMessageStream,
	createUIMessageStreamResponse,
	safeValidateUIMessages,
	type UIMessageStreamWriter,
} from "ai";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppDeps, AppEnv } from "@/deps";
import {
	ConversationIdParam,
	MAX_REQUEST_BODY_BYTES,
	RunIdParam,
} from "@/features/conversations/conversations.schema";
import { requireInternalIdentity } from "@/features/conversations/internal-identity";
import {
	ActiveRunExistsError,
	ConversationArchivedError,
	ConversationNotFoundError,
} from "@/features/run-store/run-store";

const app = new Hono<AppEnv>();
const MAX_MESSAGE_LENGTH = 50_000;

const AiChatBody = z.strictObject({
	id: ConversationIdParam,
	messages: z.unknown(),
	trigger: z.literal("submit-message"),
});

async function waitForRunEvents(
	deps: AppDeps,
	run: RunRecord,
	signal: AbortSignal,
) {
	for (;;) {
		const attached = await deps.liveStreamRelay.attach(run.runId, signal);
		if (attached.outcome === "attached") return attached;
		if (attached.outcome !== "no_producer") {
			throw new Error("Live stream unavailable");
		}

		const current = await deps.runStore.getRun({
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
		});
		if (!current) throw new Error("Run not found");
		if (isTerminalRunStatus(current.status)) {
			return { outcome: "terminal" as const, status: current.status };
		}
		if (current.liveStreamFailedAt) {
			throw new Error("Live stream unavailable");
		}
	}
}

async function writeAiMessageStream(
	writer: UIMessageStreamWriter,
	events: AsyncIterable<Uint8Array>,
) {
	let messageStarted = false;
	for await (const chunk of events) {
		const event = decodeAgUiLiveStreamEvent(chunk);
		switch (event.type) {
			case EventType.TEXT_MESSAGE_START:
				if (!messageStarted) {
					writer.write({ type: "start", messageId: event.messageId });
					messageStarted = true;
				}
				writer.write({ type: "text-start", id: event.messageId });
				break;
			case EventType.TEXT_MESSAGE_CONTENT:
				writer.write({
					type: "text-delta",
					id: event.messageId,
					delta: event.delta,
				});
				break;
			case EventType.TEXT_MESSAGE_END:
				writer.write({ type: "text-end", id: event.messageId });
				break;
			case EventType.RUN_FINISHED:
				writer.write({ type: "finish", finishReason: "stop" });
				return;
			case EventType.RUN_ERROR:
				writer.write({ type: "error", errorText: "Run failed" });
				writer.write({ type: "finish", finishReason: "error" });
				return;
			case RUN_INTERRUPTED_EVENT_TYPE:
				writer.write({ type: "abort" });
				return;
		}
	}
}

app.post(
	"/",
	bodyLimit({
		maxSize: MAX_REQUEST_BODY_BYTES,
		onError: (c) => c.json({ error: "Request body too large" }, 413),
	}),
	zValidator("json", AiChatBody, (result, c) => {
		if (!result.success)
			return c.json({ error: "Invalid AI SDK chat input" }, 400);
	}),
	requireInternalIdentity,
	async (c) => {
		const body = c.req.valid("json");
		const validated = await safeValidateUIMessages({ messages: body.messages });
		const finalMessage = validated.success ? validated.data.at(-1) : undefined;
		const part = finalMessage?.parts[0];
		if (
			finalMessage?.role !== "user" ||
			finalMessage.parts.length !== 1 ||
			part?.type !== "text" ||
			!RunIdParam.safeParse(finalMessage.id).success ||
			part.text.length === 0 ||
			part.text.length > MAX_MESSAGE_LENGTH
		) {
			return c.json({ error: "Final message must contain only text" }, 400);
		}

		const conversation = await c.var.deps.conversationStore.get({
			userId: c.var.identity.memberCode,
			conversationId: body.id,
		});
		if (!conversation) return c.json({ error: "Conversation not found" }, 404);

		if (!(await c.var.deps.exposureGate.isAgentEnabled(c.var.identity))) {
			return c.json({ error: "Agent is not enabled" }, 403);
		}

		let run: RunRecord;
		try {
			const admission = await c.var.deps.runStore.admitRun({
				conversation,
				runId: finalMessage.id,
				messageId: finalMessage.id,
				message: part.text,
			});
			if (admission.outcome === "not_found") {
				return c.json({ error: "Run not found" }, 404);
			}
			run = admission.run;
		} catch (error) {
			if (error instanceof ActiveRunExistsError) {
				return c.json({ error: "Conversation already has an active Run" }, 409);
			}
			if (error instanceof RunInputMismatchError) {
				return c.json(
					{ error: "Message id was reused with different input" },
					409,
				);
			}
			if (error instanceof ConversationArchivedError) {
				return c.json({ error: "Conversation is archived" }, 409);
			}
			if (error instanceof ConversationNotFoundError) {
				return c.json({ error: "Conversation not found" }, 404);
			}
			throw error;
		}

		const stream = createUIMessageStream({
			async execute({ writer }) {
				const source = await waitForRunEvents(
					c.var.deps,
					run,
					c.req.raw.signal,
				);
				if (source.outcome === "attached") {
					await writeAiMessageStream(writer, source.events);
					return;
				}
				switch (source.status) {
					case "done":
						writer.write({
							type: "error",
							errorText: "Live response unavailable",
						});
						writer.write({ type: "finish", finishReason: "error" });
						break;
					case "error":
						writer.write({ type: "error", errorText: "Run failed" });
						writer.write({ type: "finish", finishReason: "error" });
						break;
					case "interrupted":
						writer.write({ type: "abort" });
						break;
				}
			},
		});
		return createUIMessageStreamResponse({ stream });
	},
);

export default app;
