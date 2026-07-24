import { describe, expect, it } from "bun:test";
import { EventType } from "@ag-ui/core";
import {
	LIVE_STREAM_MAX_BYTES,
	LIVE_STREAM_MAX_EVENT_BYTES,
	LIVE_STREAM_MAX_EVENTS,
	RUN_CANCELLED_EVENT_TYPE,
} from "./live-stream-events";
import type {
	LiveStreamRelay,
	LiveStreamRelayOptions,
} from "./live-stream-relay";
import type {
	LiveStreamOperation,
	LiveStreamResult,
} from "./live-stream-telemetry";

export interface LiveStreamRelayContractFactory {
	create(options?: LiveStreamRelayOptions): Promise<LiveStreamRelay>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function event(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

async function collect(events: AsyncIterable<Uint8Array>): Promise<unknown[]> {
	const collected: unknown[] = [];
	for await (const encoded of events) {
		collected.push(JSON.parse(decoder.decode(encoded)));
	}
	return collected;
}

export function liveStreamRelayContract(
	name: string,
	factory: LiveStreamRelayContractFactory,
): void {
	describe(`${name} Live Stream relay`, () => {
		it("attaches from the beginning and ends after the terminal event", async () => {
			const relay = await factory.create();
			try {
				const producer = await relay.openProducer("run-1");
				const attached = await relay.attach(
					"run-1",
					new AbortController().signal,
				);
				expect(attached.outcome).toBe("attached");
				if (attached.outcome !== "attached") {
					throw new Error("expected a living producer");
				}

				const collecting = collect(attached.events);
				await producer.append(
					event({
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId: "message-1",
						delta: "hello",
					}),
				);
				await producer.publishTerminal(
					event({
						type: EventType.RUN_FINISHED,
						threadId: "conversation-1",
						runId: "run-1",
					}),
				);
				await producer.close();

				expect(await collecting).toEqual([
					{
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId: "message-1",
						delta: "hello",
					},
					{
						type: EventType.RUN_FINISHED,
						threadId: "conversation-1",
						runId: "run-1",
					},
				]);
			} finally {
				await relay.close();
			}
		});

		it("joins a concurrent backlog and live tail without gaps or duplicates", async () => {
			const relay = await factory.create();
			try {
				const producer = await relay.openProducer("run-1");
				const textEvents = Array.from({ length: 6 }, (_, index) => ({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "message-1",
					delta: `event-${index + 1}`,
				}));
				await producer.append(event(textEvents[0]));
				await producer.append(event(textEvents[1]));

				const [attached] = await Promise.all([
					relay.attach("run-1", new AbortController().signal),
					producer.append(event(textEvents[2])),
					producer.append(event(textEvents[3])),
				]);
				expect(attached.outcome).toBe("attached");
				if (attached.outcome !== "attached") {
					throw new Error("expected a living producer");
				}
				const collecting = collect(attached.events);

				await Promise.all([
					producer.append(event(textEvents[4])),
					producer.append(event(textEvents[5])),
				]);
				const terminal = {
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				};
				await producer.publishTerminal(event(terminal));
				await producer.close();

				const received = await collecting;
				expect(received).toEqual([...textEvents, terminal]);
				for (const receivedEvent of received) {
					expect(receivedEvent).not.toHaveProperty("ordinal");
				}
			} finally {
				await relay.close();
			}
		});

		it("reports no producer within a bound and permits a fresh attach", async () => {
			const relay = await factory.create({ backlogWaitMs: 40 });
			try {
				const startedAt = performance.now();
				expect(
					await relay.attach("run-1", new AbortController().signal),
				).toEqual({ outcome: "no_producer" });
				expect(performance.now() - startedAt).toBeLessThan(500);

				const producer = await relay.openProducer("run-1");
				const attached = await relay.attach(
					"run-1",
					new AbortController().signal,
				);
				expect(attached.outcome).toBe("attached");
				if (attached.outcome !== "attached") {
					throw new Error("expected the retry to find the producer");
				}
				const collecting = collect(attached.events);
				await producer.publishTerminal(
					event({
						type: EventType.RUN_FINISHED,
						threadId: "conversation-1",
						runId: "run-1",
					}),
				);
				await producer.close();
				expect(await collecting).toHaveLength(1);
			} finally {
				await relay.close();
			}
		});

		it("delivers the custom terminal and stops answering after close", async () => {
			const relay = await factory.create({ backlogWaitMs: 40 });
			try {
				const producer = await relay.openProducer("run-1");
				const attached = await relay.attach(
					"run-1",
					new AbortController().signal,
				);
				if (attached.outcome !== "attached") {
					throw new Error("expected a living producer");
				}
				const collecting = collect(attached.events);
				const terminal = {
					type: RUN_CANCELLED_EVENT_TYPE,
					threadId: "conversation-1",
					runId: "run-1",
				};
				await producer.publishTerminal(event(terminal));
				await producer.close();

				expect(await collecting).toEqual([terminal]);
				expect(
					await relay.attach("run-1", new AbortController().signal),
				).toEqual({ outcome: "no_producer" });
			} finally {
				await relay.close();
			}
		});

		it("keeps concurrent readers independent when one aborts", async () => {
			const relay = await factory.create();
			try {
				const producer = await relay.openProducer("run-1");
				const firstReader = new AbortController();
				const secondReader = new AbortController();
				const [firstAttach, secondAttach] = await Promise.all([
					relay.attach("run-1", firstReader.signal),
					relay.attach("run-1", secondReader.signal),
				]);
				if (
					firstAttach.outcome !== "attached" ||
					secondAttach.outcome !== "attached"
				) {
					throw new Error("expected both readers to attach");
				}

				const firstIterator = firstAttach.events[Symbol.asyncIterator]();
				const firstEvent = {
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "message-1",
					delta: "first",
				};
				const secondEvent = {
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "message-1",
					delta: "second",
				};
				const terminal = {
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				};
				const firstReaderNext = firstIterator.next();
				const secondCollecting = collect(secondAttach.events);
				await producer.append(event(firstEvent));
				expect(
					JSON.parse(decoder.decode((await firstReaderNext).value)),
				).toEqual(firstEvent);

				firstReader.abort();
				expect(await firstIterator.next()).toEqual({
					value: undefined,
					done: true,
				});
				await producer.append(event(secondEvent));
				await producer.publishTerminal(event(terminal));
				await producer.close();

				expect(await secondCollecting).toEqual([
					firstEvent,
					secondEvent,
					terminal,
				]);
			} finally {
				await relay.close();
			}
		});

		it("accepts exactly one bounded serialized AG-UI event per append", async () => {
			expect(LIVE_STREAM_MAX_EVENT_BYTES).toBe(32 * 1_024);
			const relay = await factory.create();
			try {
				const producer = await relay.openProducer("run-1");
				const attached = await relay.attach(
					"run-1",
					new AbortController().signal,
				);
				if (attached.outcome !== "attached") {
					throw new Error("expected a living producer");
				}
				const collecting = collect(attached.events);

				await expect(
					producer.append(event({ type: "UNKNOWN" })),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(
					producer.append(
						encoder.encode(
							'{"type":"TEXT_MESSAGE_CONTENT","messageId":"m","delta":"ok"}\n{}',
						),
					),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(
					producer.append(
						event({
							type: EventType.CUSTOM,
							name: "too-large",
							value: "x".repeat(LIVE_STREAM_MAX_EVENT_BYTES),
						}),
					),
				).rejects.toMatchObject({ code: "event_too_large" });

				const terminal = {
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				};
				await producer.publishTerminal(event(terminal));
				await producer.close();
				expect(await collecting).toEqual([terminal]);
			} finally {
				await relay.close();
			}
		});

		it("surfaces per-Run byte and event cap crossings without ending readers", async () => {
			expect(LIVE_STREAM_MAX_BYTES).toBe(8 * 1_024 * 1_024);
			expect(LIVE_STREAM_MAX_EVENTS).toBe(10_000);
			const textEvent = event({
				type: EventType.TEXT_MESSAGE_CONTENT,
				messageId: "message-1",
				delta: "bounded",
			});

			for (const limit of [
				{
					options: { maxBufferBytes: textEvent.byteLength * 2 },
					code: "stream_bytes_exceeded",
				},
				{
					options: { maxEvents: 2 },
					code: "stream_events_exceeded",
				},
			]) {
				const relay = await factory.create({ testLimits: limit.options });
				try {
					const producer = await relay.openProducer("run-1");
					const reader = new AbortController();
					const attached = await relay.attach("run-1", reader.signal);
					if (attached.outcome !== "attached") {
						throw new Error("expected a living producer");
					}
					const iterator = attached.events[Symbol.asyncIterator]();
					await producer.append(textEvent);
					await producer.append(textEvent);
					await expect(producer.append(textEvent)).rejects.toMatchObject({
						code: limit.code,
					});

					expect((await iterator.next()).done).toBe(false);
					expect((await iterator.next()).done).toBe(false);
					reader.abort();
					expect((await iterator.next()).done).toBe(true);
					await producer.close();
				} finally {
					await relay.close();
				}
			}
		});

		it("emits payload-free telemetry", async () => {
			const records: Array<{
				operation: LiveStreamOperation;
				result: LiveStreamResult;
				options?: { reason?: string; durationMs?: number };
			}> = [];
			const relay = await factory.create({
				telemetry: {
					record(operation, result, options) {
						records.push({ operation, result, options });
					},
				},
			});
			try {
				const producer = await relay.openProducer("private-run-id");
				const attached = await relay.attach(
					"private-run-id",
					new AbortController().signal,
				);
				if (attached.outcome !== "attached") {
					throw new Error("expected a living producer");
				}
				const collecting = collect(attached.events);
				await producer.append(
					event({
						type: EventType.TEXT_MESSAGE_CONTENT,
						messageId: "private-message-id",
						delta: "private assistant output",
					}),
				);
				await producer.publishTerminal(
					event({
						type: EventType.RUN_FINISHED,
						threadId: "private-conversation-id",
						runId: "private-run-id",
					}),
				);
				await producer.close();
				await collecting;

				expect(records.length).toBeGreaterThan(0);
				const serialized = JSON.stringify(records);
				expect(serialized).not.toContain("private-run-id");
				expect(serialized).not.toContain("private-message-id");
				expect(serialized).not.toContain("private assistant output");
				expect(serialized).not.toContain("private-conversation-id");
			} finally {
				await relay.close();
			}
		});

		it("publishes one terminal as the producer's final event", async () => {
			const relay = await factory.create();
			try {
				const producer = await relay.openProducer("run-1");
				const textEvent = event({
					type: EventType.TEXT_MESSAGE_CONTENT,
					messageId: "message-1",
					delta: "hello",
				});
				const terminal = event({
					type: EventType.RUN_FINISHED,
					threadId: "conversation-1",
					runId: "run-1",
				});

				await expect(producer.publishTerminal(textEvent)).rejects.toThrow(
					"requires a terminal",
				);
				await expect(producer.append(terminal)).rejects.toThrow(
					"does not accept terminal",
				);
				await producer.append(textEvent);
				await producer.publishTerminal(terminal);
				await expect(producer.append(textEvent)).rejects.toThrow(
					"already published",
				);
				await expect(producer.publishTerminal(terminal)).rejects.toThrow(
					"already published",
				);
				await producer.close();
			} finally {
				await relay.close();
			}
		});
	});
}
