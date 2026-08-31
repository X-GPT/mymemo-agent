import { describe, expect, it } from "bun:test";
import {
	parseTurnOutcomeEvent,
	TURN_LIVE_STREAM_MAX_EVENT_BYTES,
	TURN_OUTCOME_EVENT_TYPE,
	type TurnLiveStreamRelay,
	type TurnLiveStreamRelayOptions,
} from "./turn-live-stream-relay";

export interface TurnLiveStreamRelayContractFactory {
	create(options?: TurnLiveStreamRelayOptions): Promise<TurnLiveStreamRelay>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function chunk(value: unknown): Uint8Array {
	return encoder.encode(JSON.stringify(value));
}

function textDelta(delta: string): Uint8Array {
	return chunk({ type: "text-delta", id: "text-1", delta });
}

async function collect(events: AsyncIterable<Uint8Array>): Promise<unknown[]> {
	const collected: unknown[] = [];
	for await (const encoded of events) {
		collected.push(JSON.parse(decoder.decode(encoded)));
	}
	return collected;
}

export function turnLiveStreamRelayContract(
	name: string,
	factory: TurnLiveStreamRelayContractFactory,
): void {
	describe(`${name} Turn Live Stream relay`, () => {
		it("delivers UIMessage chunks in order and ends after the Outcome event", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const collecting = collect(events);

				const deltas = Array.from({ length: 5 }, (_, index) =>
					textDelta(`delta-${index + 1}`),
				);
				await Promise.all(deltas.map((delta) => publisher.publish(delta)));
				await publisher.publishOutcome("done");
				await publisher.close();

				const received = await collecting;
				expect(received).toEqual([
					...deltas.map((delta) => JSON.parse(decoder.decode(delta))),
					{ type: TURN_OUTCOME_EVENT_TYPE, outcome: "done" },
				]);
				const last = received.at(-1);
				expect(parseTurnOutcomeEvent(chunk(last))).toEqual({
					type: TURN_OUTCOME_EVENT_TYPE,
					outcome: "done",
				});
			} finally {
				await relay.close();
			}
		});

		it("delivers each Outcome of the triad as the terminal event", async () => {
			for (const outcome of ["done", "error", "interrupted"] as const) {
				const relay = await factory.create();
				try {
					const publisher = relay.openPublisher("turn-1");
					const events = await relay.subscribe(
						"turn-1",
						new AbortController().signal,
					);
					const collecting = collect(events);
					await publisher.publishOutcome(outcome);
					await publisher.close();
					expect(await collecting).toEqual([
						{ type: TURN_OUTCOME_EVENT_TYPE, outcome },
					]);
				} finally {
					await relay.close();
				}
			}
		});

		it("has no backlog: a late subscriber misses earlier events", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				await publisher.publish(textDelta("missed-1"));
				await publisher.publish(textDelta("missed-2"));

				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const collecting = collect(events);
				await publisher.publish(textDelta("seen"));
				await publisher.publishOutcome("done");
				await publisher.close();

				expect(await collecting).toEqual([
					{ type: "text-delta", id: "text-1", delta: "seen" },
					{ type: TURN_OUTCOME_EVENT_TYPE, outcome: "done" },
				]);
			} finally {
				await relay.close();
			}
		});

		it("has no re-attach: after the Turn ends a subscriber sees nothing", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				await publisher.publish(textDelta("gone"));
				await publisher.publishOutcome("done");
				await publisher.close();

				const subscriber = new AbortController();
				const events = await relay.subscribe("turn-1", subscriber.signal);
				const collecting = collect(events);
				setTimeout(() => subscriber.abort(), 50);
				expect(await collecting).toEqual([]);
			} finally {
				await relay.close();
			}
		});

		it("ends an aborted subscriber without disturbing another", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const aborting = new AbortController();
				const [abortedEvents, stayingEvents] = await Promise.all([
					relay.subscribe("turn-1", aborting.signal),
					relay.subscribe("turn-1", new AbortController().signal),
				]);
				const abortedCollecting = collect(abortedEvents);
				const stayingCollecting = collect(stayingEvents);

				aborting.abort();
				expect(await abortedCollecting).toEqual([]);

				await publisher.publish(textDelta("after-abort"));
				await publisher.publishOutcome("done");
				await publisher.close();
				expect(await stayingCollecting).toEqual([
					{ type: "text-delta", id: "text-1", delta: "after-abort" },
					{ type: TURN_OUTCOME_EVENT_TYPE, outcome: "done" },
				]);
			} finally {
				await relay.close();
			}
		});

		it("rejects malformed, reserved-type, and oversize chunks without failing the stream", async () => {
			expect(TURN_LIVE_STREAM_MAX_EVENT_BYTES).toBe(32 * 1_024);
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const collecting = collect(events);

				await expect(
					publisher.publish(encoder.encode("not json")),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(publisher.publish(chunk(["a"]))).rejects.toMatchObject({
					code: "invalid_event",
				});
				await expect(
					publisher.publish(chunk({ delta: "no type" })),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(
					publisher.publish(chunk({ type: TURN_OUTCOME_EVENT_TYPE })),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(
					publisher.publish(
						chunk({
							type: "text-delta",
							id: "text-1",
							delta: "x".repeat(TURN_LIVE_STREAM_MAX_EVENT_BYTES),
						}),
					),
				).rejects.toMatchObject({ code: "event_too_large" });

				await publisher.publish(textDelta("still-alive"));
				await publisher.publishOutcome("done");
				await publisher.close();
				expect(await collecting).toEqual([
					{ type: "text-delta", id: "text-1", delta: "still-alive" },
					{ type: TURN_OUTCOME_EVENT_TYPE, outcome: "done" },
				]);
			} finally {
				await relay.close();
			}
		});

		it("publishes exactly one Outcome as the publisher's final event", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				await publisher.publish(textDelta("hello"));
				await publisher.publishOutcome("done");
				await expect(
					publisher.publish(textDelta("late")),
				).rejects.toMatchObject({ code: "terminal_already_published" });
				await expect(publisher.publishOutcome("done")).rejects.toMatchObject({
					code: "terminal_already_published",
				});
				await publisher.close();
				await expect(
					publisher.publish(textDelta("closed")),
				).rejects.toMatchObject({ code: "producer_closed" });
			} finally {
				await relay.close();
			}
		});

		it("latches a failed publish and fails subscribers", async () => {
			const relay = await factory.create({
				testHooks: {
					failPublishWhen: (chunkType) => chunkType === "text-delta",
				},
			});
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const subscriberFailure = collect(events).then(
					() => undefined,
					(error: unknown) => error,
				);

				await expect(
					publisher.publish(textDelta("will-fail")),
				).rejects.toMatchObject({ code: "relay_failed" });
				await expect(
					publisher.publish(chunk({ type: "text-start", id: "text-1" })),
				).rejects.toMatchObject({ code: "producer_failed" });
				await expect(publisher.publishOutcome("done")).rejects.toMatchObject({
					code: "producer_failed",
				});
				expect(await subscriberFailure).toMatchObject({ code: "relay_failed" });
				await publisher.close();
			} finally {
				await relay.close();
			}
		});

		it("fails subscribers when the publisher closes without an Outcome", async () => {
			const relay = await factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const subscriberFailure = collect(events).then(
					() => undefined,
					(error: unknown) => error,
				);
				await publisher.publish(textDelta("interrupted mid-stream"));
				await publisher.close();
				expect(await subscriberFailure).toMatchObject({ code: "relay_failed" });
			} finally {
				await relay.close();
			}
		});

		it("refuses new publishers and subscribers after the relay closes", async () => {
			const relay = await factory.create();
			await relay.close();
			expect(() => relay.openPublisher("turn-1")).toThrow(
				expect.objectContaining({ code: "relay_closed" }),
			);
			await expect(
				relay.subscribe("turn-1", new AbortController().signal),
			).rejects.toMatchObject({ code: "relay_closed" });
		});
	});
}
