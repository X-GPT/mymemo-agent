import type { Message, RunErrorEvent, RunFinishedEvent } from "@ag-ui/core";
import type { ConversationScope } from "@/features/conversation-store";

export interface ConversationSummary {
	conversationId: string;
	title: string | null;
	scope: ConversationScope;
	collectionId: string | null;
	summaryId: string | null;
	createdAt: Date;
	lastActivityAt: Date;
	archivedAt: Date | null;
}

/** ADR-0012 names cancellation as its own standard terminal event. The pinned
 * AG-UI package does not expose that type yet, so keep this narrow bridge local
 * to the history contract until the package adds it. */
export interface RunCancelledEvent {
	type: "RUN_CANCELLED";
	threadId: string;
	runId: string;
}

export type RunTerminalEvent =
	| RunFinishedEvent
	| RunErrorEvent
	| RunCancelledEvent;

export interface ConversationHistoryRun {
	runId: string;
	messages: Message[];
	terminalEvent: RunTerminalEvent | null;
}

export interface ActiveRunSummary {
	runId: string;
	status: "queued" | "running" | "cancel_requested";
	lastEventId: "0";
}

export interface ConversationHistoryPage {
	conversation: ConversationSummary;
	runs: ConversationHistoryRun[];
	nextCursor: string | null;
	activeRun: ActiveRunSummary | null;
}

export interface ConversationHistoryPageInput {
	userId: string;
	conversationId: string;
	limit: number;
	cursor: string | null;
}

export interface ConversationHistoryStore {
	getPage(
		input: ConversationHistoryPageInput,
	): Promise<ConversationHistoryPage | null>;
}

export class InvalidConversationHistoryCursorError extends Error {
	override name = "InvalidConversationHistoryCursorError" as const;
}
