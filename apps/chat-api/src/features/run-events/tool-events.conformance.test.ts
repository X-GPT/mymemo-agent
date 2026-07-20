import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	isToolResultPayload,
	isToolUsePayload,
	type PublicToolName,
} from "@mymemo/agent-db/run-events";
import { conversations, runs } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { PostgresRunStore } from "@/features/run-store";
import type { WorkerLogger } from "../../../../agent-worker/src/logger";
import { RunLoop } from "../../../../agent-worker/src/run-loop";
import { createSdkRunProcessor } from "../../../../agent-worker/src/sdk/run-processor";
import { EXECUTOR_SERVER_NAME } from "../../../../agent-worker/src/sdk/run-tools";
import {
	toolEnvelope,
	toolResultUserMessage,
} from "../../../../agent-worker/src/sdk/testing/sdk-message-fixtures";
import { Worker } from "../../../../agent-worker/src/worker";
import { type ProjectedFrame, projectRun } from "./project-run";
import { projectRunEvent } from "./project-run-event";
import { DrizzleRunEventReader } from "./run-event-reader";
import type { ClientFrame } from "./run-event-types";
import { RunEventType } from "./run-event-types";
import type { RunNotifier, RunSubscription } from "./run-notifier";

const RUN_ID = "run-tool-conformance";
const OVERSIZED_WRITE_CONTENT = "W".repeat(100_000);
const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.insert(conversations).values({
		userId: "user-1",
		conversationId: "conversation-1",
		scope: "general",
	});
});

afterEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversations);
});

class InstantNotifier implements RunNotifier {
	async subscribe(): Promise<RunSubscription> {
		return {
			waitForWakeup: async () => {},
			close: async () => {},
		};
	}
}

function executorToolName(tool: PublicToolName): string {
	return `mcp__${EXECUTOR_SERVER_NAME}__${tool}`;
}

function executorResult(result: Record<string, unknown>): string {
	return JSON.stringify(result);
}

async function drain(
	projected: AsyncGenerator<ProjectedFrame>,
): Promise<ProjectedFrame[]> {
	const frames: ProjectedFrame[] = [];
	for await (const frame of projected) frames.push(frame);
	return frames;
}

describe("durable tool-event conformance", () => {
	it("projects one mixed nine-tool Run with ordered, guarded, reconnectable frames", async () => {
		const messages = [
			...toolEnvelope({
				text: "I will inspect the workspace and documents.",
				toolUses: [
					{
						toolUseId: "toolu-read",
						name: executorToolName("Read"),
						input: { path: "src/index.ts", offset: 2, limit: 20 },
					},
					{
						toolUseId: "toolu-write",
						name: executorToolName("Write"),
						input: { path: "notes.md", content: OVERSIZED_WRITE_CONTENT },
					},
					{
						toolUseId: "toolu-edit",
						name: executorToolName("Edit"),
						input: {
							path: "src/app.ts",
							oldText: "const a",
							newText: "const alpha",
						},
					},
					{
						toolUseId: "toolu-grep",
						name: executorToolName("Grep"),
						input: {
							pattern: "TODO",
							path: "src",
							include: "*.ts",
							caseSensitive: false,
							maxResults: 20,
						},
					},
					{
						toolUseId: "toolu-unknown",
						name: "WebSearch",
						input: { query: "unknown-tool-secret" },
					},
					{
						toolUseId: "toolu-glob",
						name: executorToolName("Glob"),
						input: {
							pattern: "**/*.ts",
							path: "src",
							includeHidden: false,
							maxResults: 40,
						},
					},
					{
						toolUseId: "toolu-bash",
						name: executorToolName("Bash"),
						input: { command: "bun test", cwd: "apps", timeoutMs: 30_000 },
					},
					{
						toolUseId: "toolu-list",
						name: executorToolName("ListDocuments"),
						input: { limit: 20, cursor: "inventory-cursor-secret" },
					},
					{
						toolUseId: "toolu-search",
						name: executorToolName("SearchDocuments"),
						input: {
							query: "quarterly roadmap",
							maxResults: 8,
							scope: "collection-secret",
						},
					},
				],
			}),
			toolResultUserMessage([
				{
					toolUseId: "toolu-list",
					text: executorResult({
						total: 42,
						documents: [
							{
								documentId: "inventory-document-secret",
								title: "Inventory title",
								sourceType: "pdf",
								language: "en",
								createdAt: "2026-07-15T00:00:00.000Z",
							},
						],
						nextCursor: "next-inventory-cursor-secret",
					}),
				},
				{
					toolUseId: "toolu-search",
					text: executorResult({
						passages: [
							{
								passageId: "passage-secret",
								documentId: "document-secret",
								title: "Q3 Roadmap",
								snippet: "Launch the durable timeline.",
							},
						],
					}),
				},
				{
					toolUseId: "toolu-unknown",
					text: executorResult({ results: ["unknown-result-secret"] }),
				},
				{
					toolUseId: "toolu-read",
					text: executorResult({
						path: "src/index.ts",
						content: "line two\nline three",
						startLine: 2,
						linesRead: 2,
						truncated: false,
					}),
				},
				{
					toolUseId: "toolu-bash",
					text: executorResult({
						exitCode: 0,
						stdout: "42 tests passed\n",
						stderr: "",
						stdoutTruncated: false,
						stderrTruncated: false,
						outcome: "completed",
					}),
				},
				{
					toolUseId: "toolu-edit",
					text: "database password leaked in raw tool error",
					isError: true,
				},
				{
					toolUseId: "toolu-glob",
					text: executorResult({
						paths: ["src/app.ts", "src/index.ts"],
						truncated: false,
					}),
				},
				{
					toolUseId: "toolu-write",
					text: executorResult({ path: "notes.md", bytesWritten: 100_000 }),
				},
				{
					toolUseId: "toolu-grep",
					text: executorResult({
						matches: [
							{
								path: "src/app.ts",
								line: 12,
								column: 3,
								text: "// TODO: fix",
							},
						],
						truncated: false,
					}),
				},
			]),
			...toolEnvelope({
				providerMessageId: "provider-message-2",
				toolUses: [
					{
						toolUseId: "toolu-load-resultless",
						name: executorToolName("LoadDocuments"),
						input: {
							documentIds: ["document-secret-1", "document-secret-2"],
							cachePath: ".mymemo/docs/document-secret-1.md",
						},
					},
				],
			}),
			{
				type: "result",
				subtype: "success",
				is_error: false,
				result: "terminal result echo",
			} as unknown as ReturnType<typeof toolEnvelope>[number],
		];
		const worker = new Worker({
			workerId: "worker-tool-conformance",
			maxConcurrentRuns: 1,
			shutdownTimeoutMs: 1_000,
			logger: silentLogger,
		});
		const loop = new RunLoop({
			db: tdb.db,
			worker,
			processor: createSdkRunProcessor({
				startRunQuery: async () => ({
					async interrupt() {},
					async *[Symbol.asyncIterator]() {
						for (const message of messages) yield message;
					},
				}),
				logger: silentLogger,
			}),
			heartbeatIntervalMs: 15_000,
			logger: silentLogger,
		});
		const runStore = new PostgresRunStore(tdb.db);
		await runStore.createQueuedRun({
			runId: RUN_ID,
			conversation: {
				userId: "user-1",
				conversationId: "conversation-1",
			},
			message: "Inspect everything",
		});

		await loop.tick();
		await worker.drain();

		const rows = await runStore.listRunEventsAfter({
			runId: RUN_ID,
			afterSeq: 0,
		});
		expect(rows.map((row) => row.type)).toEqual([
			RunEventType.Started,
			RunEventType.AssistantText,
			...Array<RunEventType>(8).fill(RunEventType.ToolUse),
			...Array<RunEventType>(8).fill(RunEventType.ToolResult),
			RunEventType.ToolUse,
			RunEventType.Done,
		]);

		const toolRows = rows.filter(
			(row) =>
				row.type === RunEventType.ToolUse ||
				row.type === RunEventType.ToolResult,
		);
		expect(toolRows).toHaveLength(17);
		for (const row of toolRows) {
			const guardValid =
				row.type === RunEventType.ToolUse
					? isToolUsePayload(row.payload)
					: isToolResultPayload(row.payload);
			expect(guardValid).toBe(true);
			expect(projectRunEvent(row.type, row.payload)).toHaveLength(1);
		}
		for (const invalid of [
			{
				type: RunEventType.ToolUse,
				payload: { tool: "Read", arguments: [], truncated: false },
				guard: isToolUsePayload,
			},
			{
				type: RunEventType.ToolResult,
				payload: {
					tool: "UnknownTool",
					result: {},
					isError: false,
					truncated: false,
				},
				guard: isToolResultPayload,
			},
		]) {
			expect(invalid.guard(invalid.payload)).toBe(false);
			expect(projectRunEvent(invalid.type, invalid.payload)).toEqual([]);
		}

		const reader = new DrizzleRunEventReader(tdb.db);
		const projected = await drain(
			projectRun(RUN_ID, 0, { reader, notifier: new InstantNotifier() }),
		);
		const frames = projected.map(({ frame }) => frame);
		expect(
			frames.map((frame): ClientFrame => {
				if (frame.type === "text_commit") {
					return { ...frame, messageId: "<message-id>" };
				}
				if (frame.type === "tool_use" && frame.tool === "Write") {
					return {
						...frame,
						arguments: {
							...frame.arguments,
							content: "<truncated-preview>",
						},
					};
				}
				return frame;
			}),
		).toEqual([
			{ type: "conversation_id", conversationId: "conversation-1" },
			{ type: "run_id", runId: RUN_ID },
			{
				type: "text_commit",
				messageId: "<message-id>",
				text: "I will inspect the workspace and documents.",
			},
			{
				type: "tool_use",
				tool: "Read",
				arguments: { path: "src/index.ts", offset: 2, limit: 20 },
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "Write",
				arguments: {
					path: "notes.md",
					content: "<truncated-preview>",
					contentBytes: 100_000,
				},
				truncated: true,
			},
			{
				type: "tool_use",
				tool: "Edit",
				arguments: {
					path: "src/app.ts",
					oldText: "const a",
					oldTextBytes: 7,
					newText: "const alpha",
					newTextBytes: 11,
				},
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "Grep",
				arguments: {
					pattern: "TODO",
					path: "src",
					include: "*.ts",
					caseSensitive: false,
					maxResults: 20,
				},
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "Glob",
				arguments: {
					pattern: "**/*.ts",
					path: "src",
					includeHidden: false,
					maxResults: 40,
				},
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "Bash",
				arguments: { command: "bun test", cwd: "apps", timeoutMs: 30_000 },
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "ListDocuments",
				arguments: { limit: 20, cursorProvided: true },
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "SearchDocuments",
				arguments: { query: "quarterly roadmap" },
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "ListDocuments",
				result: {
					total: 42,
					returnedCount: 1,
					hasMore: true,
					documents: [{ title: "Inventory title" }],
				},
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "SearchDocuments",
				result: {
					passages: [
						{ title: "Q3 Roadmap", snippet: "Launch the durable timeline." },
					],
				},
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Read",
				result: {
					path: "src/index.ts",
					content: "line two\nline three",
					startLine: 2,
					linesRead: 2,
					truncated: false,
				},
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Bash",
				result: {
					exitCode: 0,
					stdout: "42 tests passed\n",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					outcome: "completed",
				},
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Edit",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Glob",
				result: { paths: ["src/app.ts", "src/index.ts"], truncated: false },
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Write",
				result: { path: "notes.md", bytesWritten: 100_000 },
				isError: false,
				truncated: false,
			},
			{
				type: "tool_result",
				tool: "Grep",
				result: {
					matches: [
						{
							path: "src/app.ts",
							line: 12,
							column: 3,
							text: "// TODO: fix",
						},
					],
					truncated: false,
				},
				isError: false,
				truncated: false,
			},
			{
				type: "tool_use",
				tool: "LoadDocuments",
				arguments: { requestedCount: 2 },
				truncated: false,
			},
			{ type: "done" },
		]);
		expect(projected.map(({ id }) => id)).toEqual([
			undefined,
			"1",
			"2",
			"3",
			"4",
			"5",
			"6",
			"7",
			"8",
			"9",
			"10",
			"11",
			"12",
			"13",
			"14",
			"15",
			"16",
			"17",
			"18",
			"19",
			"20",
		]);

		const writeUse = frames.find(
			(frame): frame is Extract<ClientFrame, { type: "tool_use" }> =>
				frame.type === "tool_use" && frame.tool === "Write",
		);
		expect(writeUse?.truncated).toBe(true);
		expect(writeUse?.arguments.contentBytes).toBe(100_000);
		expect(writeUse?.arguments.content).not.toBe(OVERSIZED_WRITE_CONTENT);
		const serializedFrames = JSON.stringify(frames);
		expect(serializedFrames).not.toContain("collection-secret");
		expect(serializedFrames).not.toContain("document-secret");
		expect(serializedFrames).not.toContain("database password");
		expect(serializedFrames).not.toContain("unknown-tool-secret");
		expect(serializedFrames).not.toContain("unknown-result-secret");
		expect(serializedFrames).not.toContain("inventory-cursor-secret");
		expect(serializedFrames).not.toContain("inventory-document-secret");

		const reconnected = await drain(
			projectRun(RUN_ID, 18, { reader, notifier: new InstantNotifier() }),
		);
		expect(reconnected).toEqual([
			{
				seq: 19,
				id: "19",
				frame: {
					type: "tool_use",
					tool: "LoadDocuments",
					arguments: { requestedCount: 2 },
					truncated: false,
				},
			},
			{ seq: 20, id: "20", frame: { type: "done" } },
		]);
	});
});
