import { RunAgentInputSchema } from "@ag-ui/core";
import { z } from "zod";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 50_000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// conversationId is server-generated (a UUID) at create time and used by the
// worker as a sandbox filesystem path segment (the per-conversation query cwd),
// so when it arrives back as a path param on the events route it must be
// re-validated as path-safe.
const MAX_CONVERSATION_ID_LENGTH = 128;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ConversationIdParam = z
	.string()
	.min(1)
	.max(MAX_CONVERSATION_ID_LENGTH)
	.regex(CONVERSATION_ID_PATTERN);
export const RunIdParam = ConversationIdParam;

const EmptyClientObject = z.object({}).strict();
const PlainTextUserMessage = z
	.object({
		id: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
		role: z.literal("user"),
		content: z.string().min(1).max(MAX_MESSAGE_LENGTH),
	})
	.strict();

/** Strict first-slice AG-UI input profile. The upstream schema proves every
 * message is standard AG-UI; this boundary then rejects all client authority
 * except the final plain-text User message and its stable id. */
export const RunAgentInputBody = z
	.object({
		threadId: ConversationIdParam,
		runId: RunIdParam,
		parentRunId: z.never().optional(),
		state: z.union([z.null(), EmptyClientObject]).optional(),
		messages: z.array(z.unknown()).min(1),
		tools: z.array(z.never()).max(0),
		context: z.array(z.never()).max(0),
		forwardedProps: z.union([z.null(), EmptyClientObject]).optional(),
		resume: z.never().optional(),
	})
	.strict()
	.superRefine((value, context) => {
		if (!RunAgentInputSchema.safeParse(value).success) {
			context.addIssue({
				code: "custom",
				message: "Input is not a valid RunAgentInput",
			});
			return;
		}
		const finalMessage = value.messages.at(-1);
		if (!PlainTextUserMessage.safeParse(finalMessage).success) {
			context.addIssue({
				code: "custom",
				path: ["messages", value.messages.length - 1],
				message: "Final message must be one plain-text User message",
			});
		}
	});
export type RunAgentInputBody = z.infer<typeof RunAgentInputBody>;

export function submittedMessageFromRunInput(input: RunAgentInputBody): {
	messageId: string;
	message: string;
} {
	const finalMessage = input.messages.at(-1) as {
		id: string;
		role: "user";
		content: string;
	};
	return { messageId: finalMessage.id, message: finalMessage.content };
}

// Body of `POST /v1/conversations`. The scope is *resolved* from these ids and
// frozen onto the conversation; subsequent turns carry no scope. `.strict()`
// rejects extra keys (including identity, which must arrive via headers).
export const CreateConversationBody = z
	.object({
		collectionId: z.string().max(MAX_IDENTIFIER_LENGTH).nullish(),
		summaryId: z.string().max(MAX_IDENTIFIER_LENGTH).nullish(),
	})
	.strict();
export type CreateConversationBody = z.infer<typeof CreateConversationBody>;

// Body of `POST /v1/conversations/:id/events`. A discriminated union over
// `type`, mirroring the Managed Agents event model: `user.message` queues a new
// turn, `user.interrupt` cancels an existing owned run; extensible later to
// `user.tool_confirmation`, etc. without a contract rename.
const UserMessageEvent = z
	.object({
		type: z.literal("user.message"),
		text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
	})
	.strict();

// A control event for an existing run — it never creates a run and never opens
// SSE. `runId` is server-generated, so it gets the same path-safe validation as
// the path params even though it arrives in the body.
const UserInterruptEvent = z
	.object({
		type: z.literal("user.interrupt"),
		runId: RunIdParam,
	})
	.strict();

export const ConversationEventBody = z.discriminatedUnion("type", [
	UserMessageEvent,
	UserInterruptEvent,
]);
export type ConversationEventBody = z.infer<typeof ConversationEventBody>;

// Identity injected by trusted internal callers via X-* headers. Treated as
// authoritative — chat-api does not authenticate; the internal caller
// (gateway / BFF) verifies the user before forwarding. `memberCode` is the
// conversation's owner (`user_id`).
export const InternalIdentity = z.object({
	memberCode: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
	memberName: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
	teamCode: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
	partnerCode: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
	partnerName: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
});
export type InternalIdentity = z.infer<typeof InternalIdentity>;
