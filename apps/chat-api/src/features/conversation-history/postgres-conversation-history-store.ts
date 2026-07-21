import { Buffer } from "node:buffer";
import {
	type AssistantMessage,
	EventType,
	type Message,
	type ToolCall,
} from "@ag-ui/core";
import {
	InvalidRunEventError,
	parseDurableRunEvent,
	RunEventType,
	validateDurableRunEventSequence,
} from "@mymemo/agent-db/run-events";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Database } from "@/db/client";
import { conversations, runEvents, runs } from "@/db/schema";
import type { ConversationScope } from "@/features/conversation-store";
import type {
	ActiveRunSummary,
	ConversationHistoryPage,
	ConversationHistoryPageInput,
	ConversationHistoryRun,
	ConversationHistoryStore,
	RunTerminalEvent,
} from "./conversation-history-store";
import { InvalidConversationHistoryCursorError } from "./conversation-history-store";

const TERMINAL_STATUSES = ["done", "error", "canceled"] as const;
const ACTIVE_STATUSES = ["queued", "running", "cancel_requested"] as const;
// node-postgres exposes timestamps as millisecond Date values while Postgres
// stores microseconds. Use that same precision for ordering and comparison so
// Run-id tie-breaking cannot be skipped when a cursor round-trips through JSON.
const RUN_ORDER_CREATED_AT = sql<Date>`date_trunc('milliseconds', ${runs.createdAt})`;

type RunRow = typeof runs.$inferSelect;
type RunEventRow = typeof runEvents.$inferSelect;
interface HistoryCursor {
	createdAt: Date;
	runId: string;
}

export class PostgresConversationHistoryStore
	implements ConversationHistoryStore
{
	constructor(private readonly db: Database) {}

	async getPage(
		input: ConversationHistoryPageInput,
	): Promise<ConversationHistoryPage | null> {
		if (!Number.isSafeInteger(input.limit) || input.limit < 1) {
			throw new Error("History page limit must be a positive integer");
		}
		const cursor = input.cursor === null ? null : decodeCursor(input.cursor);

		const [conversation] = await this.db
			.select()
			.from(conversations)
			.where(
				and(
					eq(conversations.userId, input.userId),
					eq(conversations.conversationId, input.conversationId),
				),
			)
			.limit(1);
		if (!conversation) return null;
		// Read active first. If it terminalizes before the complete query below, the
		// complete projection wins and the captured active copy is suppressed. If it
		// terminalizes later, replay from cursor zero still bridges to its Outcome.
		const [capturedActiveRun] =
			input.cursor === null
				? await this.db
						.select()
						.from(runs)
						.where(
							and(
								eq(runs.userId, input.userId),
								eq(runs.conversationId, input.conversationId),
								inArray(runs.status, ACTIVE_STATUSES),
							),
						)
						.limit(1)
				: [];

		const completeRunFilter = and(
			eq(runs.userId, input.userId),
			eq(runs.conversationId, input.conversationId),
			inArray(runs.status, TERMINAL_STATUSES),
			cursor
				? or(
						lt(RUN_ORDER_CREATED_AT, cursor.createdAt),
						and(
							eq(RUN_ORDER_CREATED_AT, cursor.createdAt),
							lt(runs.runId, cursor.runId),
						),
					)
				: undefined,
		);
		const completeRuns = await this.db
			.select()
			.from(runs)
			.where(completeRunFilter)
			.orderBy(desc(RUN_ORDER_CREATED_AT), desc(runs.runId))
			.limit(input.limit + 1);
		const pageRows = completeRuns.slice(0, input.limit);
		const activeRun =
			capturedActiveRun &&
			!pageRows.some((run) => run.runId === capturedActiveRun.runId)
				? capturedActiveRun
				: null;
		const eventsByRun = await this.loadEvents([
			...pageRows.map((run) => run.runId),
			...(activeRun ? [activeRun.runId] : []),
		]);
		const projectedCompleteRuns = pageRows
			.map((run) => projectCompleteRun(run, eventsByRun.get(run.runId) ?? []))
			.reverse();

		return {
			conversation: {
				conversationId: conversation.conversationId,
				title: conversation.title,
				scope: conversation.scope as ConversationScope,
				collectionId: conversation.collectionId,
				summaryId: conversation.summaryId,
				createdAt: conversation.createdAt,
				lastActivityAt: conversation.lastActivityAt,
				archivedAt: conversation.archivedAt,
			},
			runs: [
				...projectedCompleteRuns,
				...(activeRun
					? [
							projectActiveRun(
								activeRun,
								eventsByRun.get(activeRun.runId) ?? [],
							),
						]
					: []),
			],
			nextCursor:
				completeRuns.length > input.limit
					? encodeCursor(pageRows[pageRows.length - 1])
					: null,
			activeRun: activeRun ? toActiveRunSummary(activeRun) : null,
		};
	}

	private async loadEvents(runIds: string[]) {
		const grouped = new Map<string, RunEventRow[]>();
		if (runIds.length === 0) return grouped;
		const rows = await this.db
			.select()
			.from(runEvents)
			.where(inArray(runEvents.runId, runIds))
			.orderBy(runEvents.runId, runEvents.seq);
		for (const row of rows) {
			const events = grouped.get(row.runId) ?? [];
			events.push(row);
			grouped.set(row.runId, events);
		}
		return grouped;
	}
}

function toActiveRunSummary(run: RunRow): ActiveRunSummary {
	if (!isActiveStatus(run.status)) {
		throw new InvalidRunEventError("captured active Run has terminal status");
	}
	return { runId: run.runId, status: run.status, lastEventId: "0" };
}

function projectActiveRun(
	run: RunRow,
	events: RunEventRow[],
): ConversationHistoryRun {
	validateDurableRunEventSequence(events, { allowIncomplete: true });
	const started = events
		.map((event) => parseDurableRunEvent(event.type, event.payload))
		.find((event) => event !== null);
	if (
		started?.type !== RunEventType.Started ||
		started.payload.runId !== run.runId ||
		started.payload.conversationId !== run.conversationId
	) {
		throw new InvalidRunEventError("invalid active durable Run start");
	}
	return {
		runId: run.runId,
		messages: [
			{
				id: started.payload.messageId,
				role: "user",
				content: started.payload.message,
			},
		],
		terminalEvent: null,
	};
}

function isActiveStatus(status: string): status is ActiveRunSummary["status"] {
	return ACTIVE_STATUSES.some((activeStatus) => activeStatus === status);
}

function encodeCursor(run: Pick<RunRow, "createdAt" | "runId"> | undefined) {
	if (!run) return null;
	return Buffer.from(
		JSON.stringify({
			createdAt: run.createdAt.toISOString(),
			runId: run.runId,
		}),
	).toString("base64url");
}

function decodeCursor(value: string): HistoryCursor {
	try {
		if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
		const decoded = JSON.parse(
			Buffer.from(value, "base64url").toString("utf8"),
		);
		if (
			typeof decoded !== "object" ||
			decoded === null ||
			typeof decoded.createdAt !== "string" ||
			typeof decoded.runId !== "string" ||
			decoded.runId.length === 0
		) {
			throw new Error("invalid cursor shape");
		}
		const createdAt = new Date(decoded.createdAt);
		if (
			!Number.isFinite(createdAt.getTime()) ||
			createdAt.toISOString() !== decoded.createdAt
		) {
			throw new Error("invalid cursor timestamp");
		}
		return { createdAt, runId: decoded.runId };
	} catch {
		throw new InvalidConversationHistoryCursorError("Invalid history cursor");
	}
}

function projectCompleteRun(
	run: RunRow,
	events: RunEventRow[],
): ConversationHistoryRun {
	validateDurableRunEventSequence(events);
	const parsed = events.flatMap((event) => {
		const value = parseDurableRunEvent(event.type, event.payload);
		return value ? [value] : [];
	});
	const started = parsed[0];
	if (
		started?.type !== RunEventType.Started ||
		started.payload.runId !== run.runId ||
		started.payload.conversationId !== run.conversationId
	) {
		throw new InvalidRunEventError("invalid durable Run start");
	}

	const messages: Message[] = [
		{
			id: started.payload.messageId,
			role: "user",
			content: started.payload.message,
		},
	];
	const assistantMessages = new Map<string, AssistantMessage>();
	const toolCalls = new Map<string, ToolCall>();
	const ensureAssistantMessage = (messageId: string) => {
		const existing = assistantMessages.get(messageId);
		if (existing) return existing;
		const message: AssistantMessage = { id: messageId, role: "assistant" };
		assistantMessages.set(messageId, message);
		messages.push(message);
		return message;
	};
	let terminalEvent: RunTerminalEvent | null = null;
	let terminalStatus: "done" | "error" | "canceled" | null = null;
	for (const event of parsed.slice(1)) {
		switch (event.type) {
			case RunEventType.AssistantMessageCompleted:
			case RunEventType.AssistantText:
				if (event.payload.text) {
					ensureAssistantMessage(event.payload.messageId).content =
						event.payload.text;
				} else {
					ensureAssistantMessage(event.payload.messageId);
				}
				break;
			case RunEventType.ToolCallStarted: {
				const assistant = ensureAssistantMessage(event.payload.parentMessageId);
				const toolCall: ToolCall = {
					id: event.payload.toolCallId,
					type: "function",
					function: { name: event.payload.toolCallName, arguments: "" },
				};
				assistant.toolCalls = [...(assistant.toolCalls ?? []), toolCall];
				toolCalls.set(toolCall.id, toolCall);
				break;
			}
			case RunEventType.ToolCallArgs: {
				const toolCall = toolCalls.get(event.payload.toolCallId);
				if (!toolCall) {
					throw new InvalidRunEventError("Tool arguments have no invocation");
				}
				toolCall.function.arguments += event.payload.delta;
				break;
			}
			case RunEventType.ToolCallResult:
				messages.push({
					id: event.payload.messageId,
					role: "tool",
					toolCallId: event.payload.toolCallId,
					content: event.payload.content,
					...(event.payload.isError ? { error: event.payload.content } : {}),
				});
				break;
			case RunEventType.Done:
				terminalStatus = "done";
				terminalEvent = {
					type: EventType.RUN_FINISHED,
					threadId: run.conversationId,
					runId: run.runId,
				};
				break;
			case RunEventType.Error:
				terminalStatus = "error";
				terminalEvent = {
					type: EventType.RUN_ERROR,
					message: event.payload.message ?? "Run failed",
				};
				break;
			case RunEventType.Canceled:
				terminalStatus = "canceled";
				terminalEvent = {
					type: "RUN_CANCELLED",
					threadId: run.conversationId,
					runId: run.runId,
				};
				break;
		}
	}
	if (terminalStatus !== run.status || terminalEvent === null) {
		throw new InvalidRunEventError("durable Run Outcome does not match status");
	}
	return { runId: run.runId, messages, terminalEvent };
}
