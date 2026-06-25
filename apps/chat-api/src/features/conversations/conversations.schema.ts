import { z } from "zod";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 50_000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// conversationId is server-generated (a UUID) at create time and used as a
// sandbox filesystem path segment (/workspace/conversations/{conversationId}/…),
// so when it arrives back as a path param on the events route it must be
// re-validated as path-safe. This contract MUST stay in sync with the
// sandbox-daemon's validation (apps/sandbox-daemon/workspace.ts).
const MAX_CONVERSATION_ID_LENGTH = 128;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const ConversationIdParam = z
	.string()
	.min(1)
	.max(MAX_CONVERSATION_ID_LENGTH)
	.regex(CONVERSATION_ID_PATTERN);

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
// `type`, mirroring the Managed Agents event model: today only `user.message`,
// extensible later to `user.interrupt`, `user.tool_confirmation`, etc. without a
// contract rename.
const UserMessageEvent = z
	.object({
		type: z.literal("user.message"),
		text: z.string().min(1).max(MAX_MESSAGE_LENGTH),
	})
	.strict();

export const ConversationEventBody = z.discriminatedUnion("type", [
	UserMessageEvent,
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
