import { z } from "zod";

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 50_000;

export const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

// conversationId becomes a sandbox filesystem path segment
// (/workspace/conversations/{conversationId}/...), so it must be path-safe.
// This contract MUST stay in sync with the sandbox-daemon's validation in
// apps/sandbox-daemon/workspace.ts (VALID_CONVERSATION_ID /
// MAX_CONVERSATION_ID_LENGTH); rejecting a bad id here gives the caller a clean
// 400 instead of letting the turn fail deeper after a sandbox is created.
const MAX_CONVERSATION_ID_LENGTH = 128;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

// Public chat payload — what an external client can supply.
// Identity (memberCode/partnerCode/etc.) is intentionally NOT part of the
// body; it must arrive via trusted internal headers (see InternalIdentity).
// `.strict()` rejects any extra keys, including identity fields, to keep the
// trust boundary unambiguous.
export const ChatBodyRequest = z
	.object({
		chatContent: z.string().min(1).max(MAX_MESSAGE_LENGTH),
		collectionId: z.string().max(MAX_IDENTIFIER_LENGTH).nullish(),
		summaryId: z.string().max(MAX_IDENTIFIER_LENGTH).nullish(),

		// Product-visible conversation thread id. When omitted, chat-api
		// generates one and emits it via the `conversation_id` SSE event;
		// clients persist it and send it back to continue the same thread.
		// This is NOT the Claude SDK resume state — that is `agentSessionId`,
		// managed server-side and never accepted from the client.
		// Restricted to a path-safe charset (see CONVERSATION_ID_PATTERN) because
		// it is used as a sandbox workspace path segment.
		conversationId: z
			.string()
			.min(1)
			.max(MAX_CONVERSATION_ID_LENGTH)
			.regex(CONVERSATION_ID_PATTERN)
			.optional(),
	})
	.strict();
export type ChatBodyRequest = z.infer<typeof ChatBodyRequest>;

// Identity injected by trusted internal callers via X-* headers. Treated as
// authoritative — chat-api itself does not authenticate; the internal caller
// (gateway / BFF) is responsible for verifying the user before forwarding.
export const InternalIdentity = z.object({
	memberCode: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
	memberName: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
	teamCode: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
	partnerCode: z.string().min(1).max(MAX_IDENTIFIER_LENGTH),
	partnerName: z.string().max(MAX_IDENTIFIER_LENGTH).optional(),
});
export type InternalIdentity = z.infer<typeof InternalIdentity>;

export type ChatRequest = ChatBodyRequest & InternalIdentity;
