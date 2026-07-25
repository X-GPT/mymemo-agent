import type { Message, RunErrorEvent, RunFinishedEvent } from "@ag-ui/core";
import type { RunInterruptedEvent } from "@mymemo/live-text";
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

export type { RunInterruptedEvent } from "@mymemo/live-text";

export type RunTerminalEvent =
	| RunFinishedEvent
	| RunErrorEvent
	| RunInterruptedEvent;

export interface ConversationHistoryRun {
	runId: string;
	messages: Message[];
	terminalEvent: RunTerminalEvent | null;
}

export interface ActiveRunSummary {
	runId: string;
	status: "queued" | "running" | "interrupt_requested";
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
