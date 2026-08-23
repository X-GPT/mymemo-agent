import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { EventType } from "@ag-ui/core";
import { RunEventType } from "@mymemo/agent-db/run-events";
import { conversations, runEvents, runs } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { and, eq, sql } from "drizzle-orm";
import { PostgresConversationStore } from "@/features/conversation-store/postgres-conversation-store";
import { PostgresConversationHistoryStore } from "./postgres-conversation-history-store";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversations);
});

describe("PostgresConversationHistoryStore", () => {
	it("projects a complete text Run into standard messages and a separate terminal event", async () => {
		const createdAt = new Date("2026-07-20T01:00:00.000Z");
		const lastActivityAt = new Date("2026-07-20T02:00:00.000Z");
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "collection",
			collectionId: "collection-1",
			summaryId: null,
			title: "Quarterly plan",
			createdAt,
			lastActivityAt,
		});
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "done",
			createdAt: lastActivityAt,
			updatedAt: lastActivityAt,
			terminalAt: new Date("2026-07-20T02:00:05.000Z"),
			nextEventSeq: 4,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-1",
					conversationId: "conversation-1",
					messageId: "user-1",
					message: "Summarize the plan",
					scope: "collection",
					collectionId: "collection-1",
					summaryId: null,
				},
			},
			{
				runId: "run-1",
				seq: 2,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-1", text: "Here is the summary." },
			},
			{
				runId: "run-1",
				seq: 3,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
		]);

		const store = new PostgresConversationHistoryStore(tdb.db);
		const page = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});

		expect(page).toEqual({
			conversation: {
				conversationId: "conversation-1",
				title: "Quarterly plan",
				scope: "collection",
				collectionId: "collection-1",
				summaryId: null,
				createdAt,
				lastActivityAt,
				archivedAt: null,
			},
			runs: [
				{
					runId: "run-1",
					messages: [
						{ id: "user-1", role: "user", content: "Summarize the plan" },
						{
							id: "assistant-1",
							role: "assistant",
							content: "Here is the summary.",
						},
					],
					terminalEvent: {
						type: EventType.RUN_FINISHED,
						threadId: "conversation-1",
						runId: "run-1",
					},
				},
			],
			nextCursor: null,
			activeRun: null,
		});
	});

	it("pages whole terminal Runs newest-first and presents each page chronologically", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		for (const [index, runId] of ["run-1", "run-2", "run-3"].entries()) {
			const createdAt = new Date(`2026-07-20T0${index + 1}:00:00.000Z`);
			await tdb.db.insert(runs).values({
				runId,
				userId: "member-1",
				conversationId: "conversation-1",
				status: "done",
				createdAt,
				updatedAt: createdAt,
				terminalAt: createdAt,
				nextEventSeq: 3,
			});
			await tdb.db.insert(runEvents).values([
				{
					runId,
					seq: 1,
					type: RunEventType.Started,
					payload: {
						runId,
						conversationId: "conversation-1",
						messageId: `user-${index + 1}`,
						message: `Question ${index + 1}`,
						scope: "general",
						collectionId: null,
						summaryId: null,
					},
				},
				{
					runId,
					seq: 2,
					type: RunEventType.Done,
					payload: { outcome: "done" },
				},
			]);
		}

		const store = new PostgresConversationHistoryStore(tdb.db);
		const newestPage = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 2,
			cursor: null,
		});

		expect(newestPage?.runs.map((run) => run.runId)).toEqual([
			"run-2",
			"run-3",
		]);
		expect(newestPage?.runs.map((run) => run.messages)).toEqual([
			[{ id: "user-2", role: "user", content: "Question 2" }],
			[{ id: "user-3", role: "user", content: "Question 3" }],
		]);
		expect(newestPage?.nextCursor).toEqual(expect.any(String));

		const olderPage = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 2,
			cursor: newestPage?.nextCursor ?? null,
		});
		expect(olderPage?.runs.map((run) => run.runId)).toEqual(["run-1"]);
		expect(olderPage?.nextCursor).toBeNull();
	});

	it("does not skip Run-id ties when Postgres timestamps contain microseconds", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.execute(sql`
			insert into runs (
				run_id, user_id, conversation_id, status, created_at, updated_at,
				terminal_at, next_event_seq
			) values
				('run-a', 'member-1', 'conversation-1', 'done',
				 '2026-07-20 01:00:00.123456+00', '2026-07-20 01:00:00.123456+00',
				 '2026-07-20 01:00:01+00', 3),
				('run-b', 'member-1', 'conversation-1', 'done',
				 '2026-07-20 01:00:00.123456+00', '2026-07-20 01:00:00.123456+00',
				 '2026-07-20 01:00:01+00', 3)
		`);
		for (const runId of ["run-a", "run-b"]) {
			await tdb.db.insert(runEvents).values([
				{
					runId,
					seq: 1,
					type: RunEventType.Started,
					payload: {
						runId,
						conversationId: "conversation-1",
						messageId: `user-${runId}`,
						message: runId,
						scope: "general",
						collectionId: null,
						summaryId: null,
					},
				},
				{
					runId,
					seq: 2,
					type: RunEventType.Done,
					payload: { outcome: "done" },
				},
			]);
		}
		const store = new PostgresConversationHistoryStore(tdb.db);

		const first = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 1,
			cursor: null,
		});
		expect(first?.runs.map((run) => run.runId)).toEqual(["run-b"]);
		const second = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 1,
			cursor: first?.nextCursor ?? null,
		});
		expect(second?.runs.map((run) => run.runId)).toEqual(["run-a"]);
	});

	it("returns the active Run outside the terminal-Run limit without cursor metadata", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.insert(runs).values([
			{
				runId: "run-complete",
				userId: "member-1",
				conversationId: "conversation-1",
				status: "done",
				createdAt: new Date("2026-07-20T01:00:00.000Z"),
				terminalAt: new Date("2026-07-20T01:00:05.000Z"),
				nextEventSeq: 3,
			},
			{
				runId: "run-active",
				userId: "member-1",
				conversationId: "conversation-1",
				status: "running",
				createdAt: new Date("2026-07-20T02:00:00.000Z"),
				nextEventSeq: 3,
			},
		]);
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-complete",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-complete",
					conversationId: "conversation-1",
					messageId: "user-complete",
					message: "Previous question",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-complete",
				seq: 2,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
			{
				runId: "run-active",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-active",
					conversationId: "conversation-1",
					messageId: "user-active",
					message: "Current question",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-active",
				seq: 2,
				type: RunEventType.AssistantMessageCompleted,
				payload: {
					messageId: "assistant-active",
					text: "Durable but replayed",
				},
			},
		]);

		const page = await new PostgresConversationHistoryStore(tdb.db).getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 1,
			cursor: null,
		});

		expect(page?.runs.map((run) => run.runId)).toEqual([
			"run-complete",
			"run-active",
		]);
		expect(page?.runs[1]).toEqual({
			runId: "run-active",
			messages: [
				{ id: "user-active", role: "user", content: "Current question" },
			],
			terminalEvent: null,
		});
		expect(page?.activeRun).toEqual({
			runId: "run-active",
			status: "running",
		});
	});

	it("projects a Tool-only response and its correlated error result as standard messages", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.insert(runs).values({
			runId: "run-tool",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "done",
			terminalAt: new Date("2026-07-20T01:00:05.000Z"),
			nextEventSeq: 8,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-tool",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-tool",
					conversationId: "conversation-1",
					messageId: "user-tool",
					message: "Read the notes",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-tool",
				seq: 2,
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-call-1",
					toolCallName: "Read",
					parentMessageId: "assistant-tool",
				},
			},
			{
				runId: "run-tool",
				seq: 3,
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-call-1", delta: '{"path":"notes.md"}' },
			},
			{
				runId: "run-tool",
				seq: 4,
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-call-1" },
			},
			{
				runId: "run-tool",
				seq: 5,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-tool", text: "" },
			},
			{
				runId: "run-tool",
				seq: 6,
				type: RunEventType.ToolCallResult,
				payload: {
					messageId: "tool-message-1",
					toolCallId: "tool-call-1",
					content: "Tool failed",
					isError: true,
				},
			},
			{
				runId: "run-tool",
				seq: 7,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
		]);

		const page = await new PostgresConversationHistoryStore(tdb.db).getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});

		expect(page?.runs[0]?.messages).toEqual([
			{ id: "user-tool", role: "user", content: "Read the notes" },
			{
				id: "assistant-tool",
				role: "assistant",
				toolCalls: [
					{
						id: "tool-call-1",
						type: "function",
						function: {
							name: "Read",
							arguments: '{"path":"notes.md"}',
						},
					},
				],
			},
			{
				id: "tool-message-1",
				role: "tool",
				toolCallId: "tool-call-1",
				content: "Tool failed",
				error: "Tool failed",
			},
		]);
	});

	it("projects durable generative UI into its owning Assistant messages", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.insert(runs).values({
			runId: "run-ui",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "done",
			terminalAt: new Date("2026-07-20T01:00:05.000Z"),
			nextEventSeq: 12,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-ui",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-ui",
					conversationId: "conversation-1",
					messageId: "user-ui",
					message: "Show the comparison",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-ui",
				seq: 2,
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-call-ui",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			},
			{
				runId: "run-ui",
				seq: 3,
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-call-ui", delta: "{}" },
			},
			{
				runId: "run-ui",
				seq: 4,
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-call-ui" },
			},
			{
				runId: "run-ui",
				seq: 5,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-1", text: "First answer" },
			},
			{
				runId: "run-ui",
				seq: 6,
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-1",
					version: 1,
					payload: {
						component: "diagram",
						props: { source: "flowchart LR\nA --> B" },
					},
				},
			},
			{
				runId: "run-ui",
				seq: 7,
				type: RunEventType.ToolCallResult,
				payload: {
					messageId: "tool-message-ui",
					toolCallId: "tool-call-ui",
					content: "Read complete",
					isError: false,
				},
			},
			{
				runId: "run-ui",
				seq: 8,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-2", text: "Second answer" },
			},
			{
				runId: "run-ui",
				seq: 9,
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-2",
					version: 7,
					futureEnvelopeField: { nested: true },
					payload: {
						component: "future-component",
						props: { future: true },
					},
				},
			},
			{
				runId: "run-ui",
				seq: 10,
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-1",
					version: 1,
					payload: {
						component: "table",
						props: { columns: [], rows: [] },
					},
				},
			},
			{
				runId: "run-ui",
				seq: 11,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
		]);

		const page = await new PostgresConversationHistoryStore(tdb.db).getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});

		expect(page?.runs[0]?.messages).toEqual([
			{ id: "user-ui", role: "user", content: "Show the comparison" },
			{
				id: "assistant-1",
				role: "assistant",
				content: "First answer",
				toolCalls: [
					{
						id: "tool-call-ui",
						type: "function",
						function: { name: "Read", arguments: "{}" },
					},
				],
				generativeUi: [
					{
						eventId: "run-ui:6",
						messageId: "assistant-1",
						version: 1,
						payload: {
							component: "diagram",
							props: { source: "flowchart LR\nA --> B" },
						},
					},
					{
						eventId: "run-ui:10",
						messageId: "assistant-1",
						version: 1,
						payload: {
							component: "table",
							props: { columns: [], rows: [] },
						},
					},
				],
			},
			{
				id: "tool-message-ui",
				role: "tool",
				toolCallId: "tool-call-ui",
				content: "Read complete",
			},
			{
				id: "assistant-2",
				role: "assistant",
				content: "Second answer",
				generativeUi: [
					{
						eventId: "run-ui:9",
						messageId: "assistant-2",
						version: 7,
						futureEnvelopeField: { nested: true },
						payload: {
							component: "future-component",
							props: { future: true },
						},
					},
				],
			},
		]);
	});

	it("keeps error and interruption Outcomes only in terminal events", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		for (const [index, outcome] of ["error", "interrupted"].entries()) {
			const runId = `run-${outcome}`;
			const createdAt = new Date(`2026-07-20T0${index + 1}:00:00.000Z`);
			await tdb.db.insert(runs).values({
				runId,
				userId: "member-1",
				conversationId: "conversation-1",
				status: outcome,
				createdAt,
				terminalAt: createdAt,
				nextEventSeq: 3,
			});
			await tdb.db.insert(runEvents).values([
				{
					runId,
					seq: 1,
					type: RunEventType.Started,
					payload: {
						runId,
						conversationId: "conversation-1",
						messageId: `user-${outcome}`,
						message: `${outcome} question`,
						scope: "general",
						collectionId: null,
						summaryId: null,
					},
				},
				{
					runId,
					seq: 2,
					type:
						outcome === "error" ? RunEventType.Error : RunEventType.Interrupted,
					payload:
						outcome === "error"
							? { outcome: "error", message: "Run failed" }
							: { outcome: "interrupted" },
				},
			]);
		}

		const page = await new PostgresConversationHistoryStore(tdb.db).getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});

		expect(page?.runs).toEqual([
			{
				runId: "run-error",
				messages: [
					{ id: "user-error", role: "user", content: "error question" },
				],
				terminalEvent: { type: EventType.RUN_ERROR, message: "Run failed" },
			},
			{
				runId: "run-interrupted",
				messages: [
					{
						id: "user-interrupted",
						role: "user",
						content: "interrupted question",
					},
				],
				terminalEvent: {
					type: "RUN_INTERRUPTED",
					threadId: "conversation-1",
					runId: "run-interrupted",
				},
			},
		]);
	});

	it("retains committed generative UI when a Run is interrupted", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.insert(runs).values({
			runId: "run-interrupted-ui",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "interrupted",
			terminalAt: new Date("2026-07-20T01:00:05.000Z"),
			nextEventSeq: 5,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-interrupted-ui",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-interrupted-ui",
					conversationId: "conversation-1",
					messageId: "user-interrupted-ui",
					message: "Show progress",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-interrupted-ui",
				seq: 2,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-interrupted-ui", text: "Progress" },
			},
			{
				runId: "run-interrupted-ui",
				seq: 3,
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-interrupted-ui",
					version: 1,
					payload: {
						component: "card",
						props: { title: "Committed" },
					},
				},
			},
			{
				runId: "run-interrupted-ui",
				seq: 4,
				type: RunEventType.Interrupted,
				payload: { outcome: "interrupted" },
			},
		]);

		const page = await new PostgresConversationHistoryStore(tdb.db).getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});

		expect(page?.runs[0]).toEqual({
			runId: "run-interrupted-ui",
			messages: [
				{
					id: "user-interrupted-ui",
					role: "user",
					content: "Show progress",
				},
				{
					id: "assistant-interrupted-ui",
					role: "assistant",
					content: "Progress",
					generativeUi: [
						{
							eventId: "run-interrupted-ui:3",
							messageId: "assistant-interrupted-ui",
							version: 1,
							payload: {
								component: "card",
								props: { title: "Committed" },
							},
						},
					],
				},
			],
			terminalEvent: {
				type: "RUN_INTERRUPTED",
				threadId: "conversation-1",
				runId: "run-interrupted-ui",
			},
		});
	});

	it("skips unknown events but rejects malformed known events as corruption", async () => {
		await tdb.db.insert(conversations).values({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
		});
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "done",
			terminalAt: new Date("2026-07-20T01:00:05.000Z"),
			nextEventSeq: 4,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-1",
					conversationId: "conversation-1",
					messageId: "user-1",
					message: "Question",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-1",
				seq: 2,
				type: "worker_internal_note",
				payload: { secret: "not projected" },
			},
			{
				runId: "run-1",
				seq: 3,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
		]);
		const store = new PostgresConversationHistoryStore(tdb.db);

		const validPage = await store.getPage({
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		});
		expect(validPage?.runs[0]?.messages).toEqual([
			{ id: "user-1", role: "user", content: "Question" },
		]);

		await tdb.db
			.update(runEvents)
			.set({
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-1",
					version: 1,
					payload: "not an object",
				},
			})
			.where(and(eq(runEvents.runId, "run-1"), eq(runEvents.seq, 2)));
		await expect(
			store.getPage({
				userId: "member-1",
				conversationId: "conversation-1",
				limit: 20,
				cursor: null,
			}),
		).rejects.toThrow("invalid payload for durable event");

		await tdb.db
			.update(runEvents)
			.set({
				type: RunEventType.AssistantMessageCompleted,
				payload: { text: "missing messageId" },
			})
			.where(and(eq(runEvents.runId, "run-1"), eq(runEvents.seq, 2)));
		await expect(
			store.getPage({
				userId: "member-1",
				conversationId: "conversation-1",
				limit: 20,
				cursor: null,
			}),
		).rejects.toThrow("invalid payload for durable event");
	});

	it("serves Postgres history after Live Stream failure and removes it on permanent deletion", async () => {
		const conversationStore = new PostgresConversationStore(tdb.db);
		await conversationStore.create({
			userId: "member-1",
			conversationId: "conversation-1",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
		await tdb.db.insert(runs).values({
			runId: "run-1",
			userId: "member-1",
			conversationId: "conversation-1",
			status: "done",
			liveStreamFailedAt: new Date("2026-07-20T01:00:01.000Z"),
			terminalAt: new Date("2026-07-20T01:00:05.000Z"),
			nextEventSeq: 4,
		});
		await tdb.db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "run-1",
					conversationId: "conversation-1",
					messageId: "user-1",
					message: "Question",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
			},
			{
				runId: "run-1",
				seq: 2,
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-1", text: "Durable answer" },
			},
			{
				runId: "run-1",
				seq: 3,
				type: RunEventType.Done,
				payload: { outcome: "done" },
			},
		]);
		const historyStore = new PostgresConversationHistoryStore(tdb.db);
		const input = {
			userId: "member-1",
			conversationId: "conversation-1",
			limit: 20,
			cursor: null,
		};

		expect((await historyStore.getPage(input))?.runs).toEqual([
			{
				runId: "run-1",
				messages: [
					{ id: "user-1", role: "user", content: "Question" },
					{
						id: "assistant-1",
						role: "assistant",
						content: "Durable answer",
					},
				],
				terminalEvent: {
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				},
			},
		]);
		await expect(
			conversationStore.deletePermanently({
				userId: "member-1",
				conversationId: "conversation-1",
			}),
		).resolves.toEqual({ outcome: "deleted" });
		await expect(historyStore.getPage(input)).resolves.toBeNull();
	});
});
