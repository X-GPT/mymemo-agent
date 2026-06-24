import type { ApiConfig } from "@/config/env";
import { createDatabase } from "@/db/client";
import type { ConversationStore } from "./conversation-store";
import { PostgresConversationStore } from "./postgres-conversation-store";

export type {
	ConversationRecord,
	ConversationRef,
	ConversationScope,
	ConversationStore,
} from "./conversation-store";
export { PostgresConversationStore } from "./postgres-conversation-store";

/**
 * Build the conversation store from config, or `null` when chat-api has no
 * database configured — mirroring {@link createLeaseStore}. Wired into the turn
 * path when frozen-scope conversations land.
 */
export function createConversationStore(
	config: ApiConfig,
): ConversationStore | null {
	if (!config.databaseUrl) return null;
	return new PostgresConversationStore(createDatabase(config.databaseUrl));
}
