import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Database } from "@/db/client";
import { runEvents, runs } from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
import { type ProjectedFrame, projectRun } from "./project-run";
import type { RunEventReader, RunEventRow } from "./run-event-reader";
import { DrizzleRunEventReader } from "./run-event-reader";
import { RunEventType } from "./run-event-types";
import type { RunNotifier, RunSubscription } from "./run-notifier";

/**
 * Reader that hands out one scripted batch per `read` call, recording the
 * `afterSeq` cursor it was called with. It models "what events are available at
 * read time" — successive reads can reveal more, independent of the cursor — so
 * the loop's cursor handling and its poll-then-reread behavior are observable.
 */
class ScriptedReader implements RunEventReader {
	readonly cursors: number[] = [];
	private readonly batches: RunEventRow[][];

	constructor(batches: RunEventRow[][]) {
		this.batches = [...batches];
	}

	async read(_runId: string, afterSeq: number): Promise<RunEventRow[]> {
		this.cursors.push(afterSeq);
		return this.batches.shift() ?? [];
	}
}

/** Notifier whose wake-up resolves instantly — each wait models one poll cycle. */
class InstantNotifier implements RunNotifier {
	waits = 0;
	closed = 0;

	async subscribe(): Promise<RunSubscription> {
		return {
			waitForWakeup: async () => {
				this.waits += 1;
			},
			close: async () => {
				this.closed += 1;
			},
		};
	}
}

class BlockingNotifier implements RunNotifier {
	closed = 0;

	async subscribe(): Promise<RunSubscription> {
		return {
			waitForWakeup: async () => new Promise<void>(() => {}),
			close: async () => {
				this.closed += 1;
			},
		};
	}
}

async function drain(
	gen: AsyncGenerator<ProjectedFrame>,
): Promise<ProjectedFrame[]> {
	const out: ProjectedFrame[] = [];
	for await (const frame of gen) out.push(frame);
	return out;
}

function frames(projected: ProjectedFrame[]) {
	return projected.map((p) => p.frame);
}

describe("projectRun", () => {
	it("replays committed Assistant messages with durable cursors", async () => {
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "hello" },
				},
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "again" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);
		const notifier = new InstantNotifier();

		const projected = await drain(projectRun("run-1", 0, { reader, notifier }));

		expect(frames(projected)).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "hello" },
			{ type: "text_commit", messageId: "message-2", text: "again" },
			{ type: "done" },
		]);
		expect(projected.map((p) => p.seq).slice(0, 2)).toEqual([1, 1]);
		// Only the final sibling from a fanned-out event advances Last-Event-ID.
		expect(projected.map((p) => p.id)).toEqual([undefined, "1", "2", "3", "4"]);
		expect(notifier.closed).toBe(1);
	});

	it("replays from a Last-Event-ID cursor, starting the read past already-seen events", async () => {
		const reader = new ScriptedReader([
			[
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "tail" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = await drain(
			projectRun("run-1", 2, { reader, notifier: new InstantNotifier() }),
		);

		expect(reader.cursors[0]).toBe(2);
		expect(frames(projected)).toEqual([
			{ type: "text_commit", messageId: "message-2", text: "tail" },
			{ type: "done" },
		]);
	});

	it("does not lose events when no notification arrives (poll then re-read)", async () => {
		// First read finds nothing (worker hasn't appended yet); the loop must wait
		// and re-read rather than close. The wake-up here is the poll timeout, not a
		// notify — proving delivery does not depend on notifications.
		const reader = new ScriptedReader([
			[],
			[
				{
					seq: 1,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "late" },
				},
				{ seq: 2, type: RunEventType.Done, payload: {} },
			],
		]);
		const notifier = new InstantNotifier();

		const projected = await drain(
			projectRun("run-1", 0, { reader, notifier, pollTimeoutMs: 5 }),
		);

		expect(notifier.waits).toBe(1); // waited once between the two reads
		expect(reader.cursors).toEqual([0, 0]); // nothing emitted yet on the re-read
		expect(frames(projected)).toEqual([
			{ type: "text_commit", messageId: "message-1", text: "late" },
			{ type: "done" },
		]);
	});

	it("stops while waiting when the client aborts", async () => {
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "one" },
				},
			],
			[],
		]);
		const notifier = new BlockingNotifier();
		const controller = new AbortController();
		const gen = projectRun("run-1", 0, {
			reader,
			notifier,
			signal: controller.signal,
		});

		expect(await gen.next()).toEqual({
			done: false,
			value: {
				seq: 1,
				id: "1",
				frame: { type: "text_commit", messageId: "message-1", text: "one" },
			},
		});
		const pending = gen.next();
		controller.abort();

		expect(await pending).toEqual({ done: true, value: undefined });
		expect(notifier.closed).toBe(1);
	});

	it("maps run_canceled to canceled and closes (never error)", async () => {
		const reader = new ScriptedReader([
			[{ seq: 1, type: RunEventType.Canceled, payload: {} }],
		]);

		const projected = await drain(
			projectRun("run-1", 0, { reader, notifier: new InstantNotifier() }),
		);

		expect(frames(projected)).toEqual([{ type: "canceled" }]);
	});

	it("maps run_error to a terminal error frame and closes", async () => {
		const reader = new ScriptedReader([
			[{ seq: 1, type: RunEventType.Error, payload: { message: "boom" } }],
		]);

		expect(
			frames(
				await drain(
					projectRun("run-1", 0, { reader, notifier: new InstantNotifier() }),
				),
			),
		).toEqual([{ type: "error", message: "boom" }]);
	});

	it("skips unmapped internal event types without leaking them or closing early", async () => {
		const reader = new ScriptedReader([
			[
				{ seq: 1, type: "document_search", payload: { query: "secret" } },
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "ok" },
				},
				{ seq: 3, type: "daemon_started", payload: {} },
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		expect(
			frames(
				await drain(
					projectRun("run-1", 0, { reader, notifier: new InstantNotifier() }),
				),
			),
		).toEqual([
			{ type: "text_commit", messageId: "message-1", text: "ok" },
			{ type: "done" },
		]);
	});

	it("stops reading once a terminal event is seen (no read past the terminal)", async () => {
		const reader = new ScriptedReader([
			[{ seq: 1, type: RunEventType.Done, payload: {} }],
			// A second batch exists but must never be requested.
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-late", text: "after" },
				},
			],
		]);

		const projected = await drain(
			projectRun("run-1", 0, { reader, notifier: new InstantNotifier() }),
		);

		expect(frames(projected)).toEqual([{ type: "done" }]);
		expect(reader.cursors).toEqual([0]); // exactly one read
	});
});

describe("projectRun over the real reader", () => {
	let db: Database;
	let close: () => Promise<void>;

	beforeEach(async () => {
		const tdb = await createTestDatabase();
		db = tdb.db;
		close = tdb.close;
		await db.insert(runs).values({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
		});
		await db.insert(runEvents).values([
			{
				runId: "run-1",
				seq: 1,
				type: RunEventType.Started,
				payload: { conversationId: "conv-1", runId: "run-1" },
			},
			{
				runId: "run-1",
				seq: 2,
				type: RunEventType.AssistantText,
				payload: { messageId: "message-1", text: "hi" },
			},
			{ runId: "run-1", seq: 3, type: RunEventType.Done, payload: {} },
		]);
	});

	afterEach(() => close());

	it("projects durable rows end to end, honoring the reconnect cursor", async () => {
		const reader = new DrizzleRunEventReader(db);
		const notifier = new InstantNotifier();

		const full = frames(
			await drain(projectRun("run-1", 0, { reader, notifier })),
		);
		expect(full).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "hi" },
			{ type: "done" },
		]);

		// Reconnect past seq 2: only the terminal remains.
		const resumed = frames(
			await drain(projectRun("run-1", 2, { reader, notifier })),
		);
		expect(resumed).toEqual([{ type: "done" }]);
	});
});
