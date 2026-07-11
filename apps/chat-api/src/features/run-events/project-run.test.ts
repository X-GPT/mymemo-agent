import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { InMemoryLiveTextTransport } from "@mymemo/live-text";
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

class TriggerNotifier implements RunNotifier {
	closed = 0;
	#pending = false;
	#resolve: (() => void) | undefined;

	async subscribe(): Promise<RunSubscription> {
		return {
			waitForWakeup: async () => {
				if (this.#pending) {
					this.#pending = false;
					return;
				}
				await new Promise<void>((resolve) => {
					this.#resolve = resolve;
				});
			},
			close: async () => {
				this.closed++;
				this.#resolve?.();
			},
		};
	}

	wake(): void {
		if (this.#resolve) {
			const resolve = this.#resolve;
			this.#resolve = undefined;
			resolve();
			return;
		}
		this.#pending = true;
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
	it("merges prepared cursorless previews before authoritative commits", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		for (const message of [
			{ messageId: "message-1", deltaIndex: 0, text: "hel" },
			{ messageId: "message-1", deltaIndex: 1, text: "lo" },
			{ messageId: "message-2", deltaIndex: 0, text: "again" },
		]) {
			await liveText.publish({ runId: "run-1", ...message });
		}
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
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

		const projected = await drain(
			projectRun("run-1", 0, {
				reader,
				notifier: new InstantNotifier(),
				liveSubscription,
			}),
		);

		expect(projected.map(({ id, frame }) => ({ id, frame }))).toEqual([
			{
				id: undefined,
				frame: { type: "conversation_id", conversationId: "conv-1" },
			},
			{
				id: "1",
				frame: { type: "run_id", runId: "run-1" },
			},
			{
				id: undefined,
				frame: {
					type: "text_delta",
					messageId: "message-1",
					deltaIndex: 0,
					text: "hel",
				},
			},
			{
				id: undefined,
				frame: {
					type: "text_delta",
					messageId: "message-1",
					deltaIndex: 1,
					text: "lo",
				},
			},
			{
				id: undefined,
				frame: {
					type: "text_delta",
					messageId: "message-2",
					deltaIndex: 0,
					text: "again",
				},
			},
			{
				id: "2",
				frame: { type: "text_commit", messageId: "message-1", text: "hello" },
			},
			{
				id: "3",
				frame: { type: "text_commit", messageId: "message-2", text: "again" },
			},
			{ id: "4", frame: { type: "done" } },
		]);
	});

	it("suppresses queued and late preview after the authoritative commit", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		await liveText.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "provisional",
		});
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
					payload: { messageId: "message-1", text: "authoritative" },
				},
				{ seq: 3, type: RunEventType.Done, payload: {} },
			],
		]);

		expect(
			frames(
				await drain(
					projectRun("run-1", 0, {
						reader,
						notifier: new InstantNotifier(),
						liveSubscription,
					}),
				),
			),
		).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{
				type: "text_commit",
				messageId: "message-1",
				text: "authoritative",
			},
			{ type: "done" },
		]);
	});

	it("suppresses an incomplete preview when its connection buffer overflows", async () => {
		const liveText = new InMemoryLiveTextTransport(1);
		const liveSubscription = await liveText.subscribe("run-1");
		await liveText.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "prefix",
		});
		await liveText.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 1,
			text: "dropped",
		});
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "prefixdropped" },
				},
				{ seq: 3, type: RunEventType.Done, payload: {} },
			],
		]);

		expect(
			frames(
				await drain(
					projectRun("run-1", 0, {
						reader,
						notifier: new InstantNotifier(),
						liveSubscription,
						onLiveTextSignal: (signal) => signals.push(signal),
					}),
				),
			),
		).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "prefixdropped" },
			{ type: "done" },
		]);
		expect(signals).toContain("queue_overflow");
	});

	it("bounds preview waiting behind a slow SSE consumer without delaying commits", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		for (const messageId of ["message-1", "message-2"]) {
			await liveText.publish({
				runId: "run-1",
				messageId,
				deltaIndex: 0,
				text: `preview ${messageId}`,
			});
		}
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "complete first" },
				},
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "complete second" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription,
					maxPreviewQueueMessages: 1,
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(
			projected
				.filter((frame) => frame.type === "text_commit")
				.map((frame) => frame.text),
		).toEqual(["complete first", "complete second"]);
		expect(signals).toContain("queue_overflow");
	});

	it("ignores a consistent duplicate but suppresses an inconsistent duplicate", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		for (const message of [
			{ messageId: "message-1", deltaIndex: 0, text: "a" },
			{ messageId: "message-1", deltaIndex: 0, text: "a" },
			{ messageId: "message-1", deltaIndex: 1, text: "b" },
			{ messageId: "message-2", deltaIndex: 0, text: "x" },
			{ messageId: "message-2", deltaIndex: 0, text: "different" },
			{ messageId: "message-2", deltaIndex: 1, text: "ignored" },
		]) {
			await liveText.publish({ runId: "run-1", ...message });
		}
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "ab" },
				},
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "xignored" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription,
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(projected.filter((frame) => frame.type === "text_delta")).toEqual([
			{ type: "text_delta", messageId: "message-1", deltaIndex: 0, text: "a" },
			{ type: "text_delta", messageId: "message-1", deltaIndex: 1, text: "b" },
		]);
		expect(signals).toEqual(["duplicate_inconsistency"]);
	});

	it("suppresses malformed preview for its message and continues durable projection", async () => {
		let read = false;
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "complete" },
				},
				{ seq: 3, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription: {
						readAvailable: () => {
							if (read) return [];
							read = true;
							return [
								{
									runId: "run-1",
									messageId: "message-1",
									deltaIndex: "bad",
									text: "must not escape",
								},
							] as never;
						},
						waitForMessage: async () => true,
						close: async () => {},
					},
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(projected).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "complete" },
			{ type: "done" },
		]);
		expect(signals).toEqual(["malformed_message"]);
	});

	it("suppresses nonzero first indexes and mid-message gaps", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		for (const message of [
			{ messageId: "message-1", deltaIndex: 4, text: "suffix" },
			{ messageId: "message-2", deltaIndex: 0, text: "prefix" },
			{ messageId: "message-2", deltaIndex: 2, text: "after gap" },
		]) {
			await liveText.publish({ runId: "run-1", ...message });
		}
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "complete first" },
				},
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "complete second" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription,
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(projected.filter((frame) => frame.type === "text_delta")).toEqual(
			[],
		);
		expect(signals).toEqual(["gap", "gap"]);
		expect(
			projected
				.filter((frame) => frame.type === "text_commit")
				.map(({ text }) => text),
		).toEqual(["complete first", "complete second"]);
	});

	it("signals and ignores a delayed delta after its durable commit", async () => {
		const signals: string[] = [];
		let read = false;
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
					payload: { messageId: "message-1", text: "authoritative" },
				},
			],
			[{ seq: 3, type: RunEventType.Done, payload: {} }],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription: {
						readAvailable: () => {
							if (read) return [];
							read = true;
							return [
								{
									runId: "run-1",
									messageId: "message-1",
									deltaIndex: 0,
									text: "late",
								},
							];
						},
						waitForMessage: async () => true,
						close: async () => {},
					},
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(projected).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "authoritative" },
			{ type: "done" },
		]);
		expect(signals).toEqual(["late_delta"]);
	});

	it("disables later Live preview after partial and complete text mismatch", async () => {
		const liveBatches = [
			[
				{
					runId: "run-1",
					messageId: "message-1",
					deltaIndex: 0,
					text: "partial",
				},
			],
			[
				{
					runId: "run-1",
					messageId: "message-2",
					deltaIndex: 0,
					text: "must be suppressed",
				},
			],
		];
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "authoritative" },
				},
			],
			[
				{
					seq: 3,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-2", text: "second commit" },
				},
				{ seq: 4, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = frames(
			await drain(
				projectRun("run-1", 0, {
					reader,
					notifier: new InstantNotifier(),
					liveSubscription: {
						readAvailable: () => liveBatches.shift() ?? [],
						waitForMessage: async () => true,
						close: async () => {},
					},
					onLiveTextSignal: (signal) => signals.push(signal),
				}),
			),
		);

		expect(projected).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 0,
				text: "partial",
			},
			{ type: "text_commit", messageId: "message-1", text: "authoritative" },
			{ type: "text_commit", messageId: "message-2", text: "second commit" },
			{ type: "done" },
		]);
		expect(signals).toContain("partial_complete_mismatch");
	});

	it("lets a terminal event purge queued preview while the client is slow", async () => {
		const liveText = new InMemoryLiveTextTransport();
		const liveSubscription = await liveText.subscribe("run-1");
		for (const [deltaIndex, text] of ["first", "queued"].entries()) {
			await liveText.publish({
				runId: "run-1",
				messageId: "message-1",
				deltaIndex,
				text,
			});
		}
		const notifier = new TriggerNotifier();
		const signals: string[] = [];
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[{ seq: 2, type: RunEventType.Done, payload: {} }],
		]);
		const gen = projectRun("run-1", 0, {
			reader,
			notifier,
			liveSubscription,
			onLiveTextSignal: (signal) => signals.push(signal),
		});

		await gen.next();
		await gen.next();
		expect((await gen.next()).value?.frame).toMatchObject({
			type: "text_delta",
			text: "first",
		});
		notifier.wake();
		for (
			let attempt = 0;
			attempt < 10 && reader.cursors.length < 2;
			attempt++
		) {
			await Bun.sleep(1);
		}

		expect(reader.cursors).toHaveLength(2);
		expect((await gen.next()).value?.frame).toEqual({ type: "done" });
		expect(signals).toContain("terminal_open_preview");
	});

	it("degrades to durable projection when the Live subscription fails", async () => {
		let closes = 0;
		const reader = new ScriptedReader([
			[
				{
					seq: 1,
					type: RunEventType.Started,
					payload: { conversationId: "conv-1", runId: "run-1" },
				},
			],
			[
				{
					seq: 2,
					type: RunEventType.AssistantText,
					payload: { messageId: "message-1", text: "durable" },
				},
				{ seq: 3, type: RunEventType.Done, payload: {} },
			],
		]);

		const projected = await drain(
			projectRun("run-1", 0, {
				reader,
				notifier: new InstantNotifier(),
				liveSubscription: {
					readAvailable() {
						throw new Error("Live transport disconnected");
					},
					async waitForMessage() {
						throw new Error("must not wait after read failure");
					},
					async close() {
						closes++;
						throw new Error("Live close failed");
					},
				},
			}),
		);

		expect(frames(projected)).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
			{ type: "text_commit", messageId: "message-1", text: "durable" },
			{ type: "done" },
		]);
		expect(closes).toBe(1);
	});

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
