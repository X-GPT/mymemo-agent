import type { UIMessage } from "ai";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

export type ChatMessage = UIMessage<unknown, never, never>;

export type UserMessageAdmission =
	| { outcome: "admitted"; conversationEpoch: number }
	| { outcome: "not_found" | "archived" | "duplicate" };

/** Persistence boundary for canonical direct-response AI SDK messages. */
export interface ChatMessageStore {
	ownedConversationExists(ref: ConversationRef): Promise<boolean>;
	admitUserMessage(
		ref: ConversationRef,
		message: ChatMessage,
	): Promise<UserMessageAdmission>;
	persistAssistantMessage(
		ref: ConversationRef,
		message: ChatMessage,
	): Promise<void>;
	listMessages(ref: ConversationRef): Promise<ChatMessage[]>;
}
