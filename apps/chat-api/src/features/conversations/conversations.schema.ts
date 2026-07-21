import { RunAgentInputSchema } from "@ag-ui/core";
import { z } from "zod";
import type { ConversationListPosition } from "@/features/conversation-store";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 50_000;
const MAX_LIST_CURSOR_LENGTH = 2_048;

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

export const UpdateConversationBody = z
	.object({
		title: z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH).optional(),
		archived: z.boolean().optional(),
	})
	.strict()
	.refine(
		(value) => value.title !== undefined || value.archived !== undefined,
		{
			message: "At least one Conversation field is required",
		},
	);
export type UpdateConversationBody = z.infer<typeof UpdateConversationBody>;

const ConversationListLimit = z
	.string()
	.regex(/^\d+$/)
	.transform(Number)
	.pipe(z.number().int().min(1).max(100));

export const ConversationListQuery = z
	.object({
		archived: z
			.enum(["true", "false"])
			.default("false")
			.transform((value) => value === "true"),
		search: z.string().trim().min(1).max(MAX_IDENTIFIER_LENGTH).optional(),
		limit: ConversationListLimit.default(20),
		cursor: z.string().min(1).max(MAX_LIST_CURSOR_LENGTH).optional(),
	})
	.strict();
export type ConversationListQuery = z.infer<typeof ConversationListQuery>;

const ConversationListCursorPayload = z
	.object({
		version: z.literal(1),
		archived: z.boolean(),
		search: z.string().nullable(),
		lastActivityAt: z.iso.datetime({ offset: true }),
		conversationId: ConversationIdParam,
	})
	.strict();

export function encodeConversationListCursor(
	query: Pick<ConversationListQuery, "archived" | "search">,
	position: ConversationListPosition,
): string {
	return Buffer.from(
		JSON.stringify({
			version: 1,
			archived: query.archived,
			search: query.search ?? null,
			lastActivityAt: position.lastActivityAt,
			conversationId: position.conversationId,
		}),
	).toString("base64url");
}

export function decodeConversationListCursor(
	cursor: string,
	query: Pick<ConversationListQuery, "archived" | "search">,
): ConversationListPosition | null {
	try {
		const decoded = Buffer.from(cursor, "base64url");
		if (decoded.toString("base64url") !== cursor) return null;
		const parsed = ConversationListCursorPayload.safeParse(
			JSON.parse(decoded.toString("utf8")),
		);
		if (!parsed.success) return null;
		if (
			parsed.data.archived !== query.archived ||
			parsed.data.search !== (query.search ?? null)
		) {
			return null;
		}
		return {
			lastActivityAt: parsed.data.lastActivityAt,
			conversationId: parsed.data.conversationId,
		};
	} catch {
		return null;
	}
}

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
