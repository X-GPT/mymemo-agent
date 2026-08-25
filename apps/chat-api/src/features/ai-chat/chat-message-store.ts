import type { UIMessage } from "ai";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";

export type UserMessageAdmission =
	| {
			outcome: "admitted";
			conversationEpoch: number;
			agentSessionId?: string;
	  }
	| { outcome: "not_found" | "archived" | "duplicate" };

export interface ChatMessageStore {
	ownedConversationExists(ref: ConversationRef): Promise<boolean>;
	admitUserMessage(
		ref: ConversationRef,
		message: UIMessage,
	): Promise<UserMessageAdmission>;
	persistAssistantMessageAndSession(
		ref: ConversationRef,
		message: UIMessage,
		agentSessionId: string,
	): Promise<void>;
}
