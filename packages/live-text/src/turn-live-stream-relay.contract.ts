import { describe, expect, it } from "bun:test";
import { LIVE_STREAM_MAX_EVENT_BYTES } from "./live-stream-events";
import type {
	TurnLiveStreamRelay,
	TurnLiveStreamRelayOptions,
} from "./turn-live-stream-relay";

export interface TurnLiveStreamRelayContractFactory {
	create(options?: TurnLiveStreamRelayOptions): TurnLiveStreamRelay;
}

function textDelta(delta: string): unknown {
	return { type: "text-delta", id: "text-1", delta };
}

const FINISH = { type: "finish" } as const;

async function collect(events: AsyncIterable<string>): Promise<unknown[]> {
	const collected: unknown[] = [];
	for await (const message of events) {
		collected.push(JSON.parse(message));
	}
	return collected;
}

export function turnLiveStreamRelayContract(
	name: string,
	factory: TurnLiveStreamRelayContractFactory,
): void {
	describe(`${name} Turn Live Stream relay`, () => {
		it("delivers UIMessage chunks in order and ends after the terminal chunk", async () => {
			const relay = factory.create();
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
				const finish = {
					type: "finish",
					messageMetadata: { turnStatus: "done" },
				};
				await publisher.publish(finish);
				await publisher.close();

				expect(await collecting).toEqual([...deltas, finish]);
			} finally {
				await relay.close();
			}
		});

		it("terminates on each of finish, abort, and error — but never finish-step", async () => {
			for (const terminal of [
				FINISH,
				{ type: "abort" },
				{ type: "error", errorText: "boom" },
			]) {
				const relay = factory.create();
				try {
					const publisher = relay.openPublisher("turn-1");
					const events = await relay.subscribe(
						"turn-1",
						new AbortController().signal,
					);
					const collecting = collect(events);
					await publisher.publish({ type: "start-step" });
					await publisher.publish({ type: "finish-step" });
					await publisher.publish({ type: "start-step" });
					await publisher.publish({ type: "finish-step" });
					await publisher.publish(terminal);
					await publisher.close();
					expect(await collecting).toEqual([
						{ type: "start-step" },
						{ type: "finish-step" },
						{ type: "start-step" },
						{ type: "finish-step" },
						terminal,
					]);
				} finally {
					await relay.close();
				}
			}
		});

		it("has no backlog: a late subscriber misses earlier chunks", async () => {
			const relay = factory.create();
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
				await publisher.publish(FINISH);
				await publisher.close();

				expect(await collecting).toEqual([textDelta("seen"), FINISH]);
			} finally {
				await relay.close();
			}
		});

		it("has no re-attach: after the Turn ends a subscriber sees nothing", async () => {
			const relay = factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				await publisher.publish(textDelta("gone"));
				await publisher.publish(FINISH);
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
			const relay = factory.create();
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
				await publisher.publish(FINISH);
				await publisher.close();
				expect(await stayingCollecting).toEqual([
					textDelta("after-abort"),
					FINISH,
				]);
			} finally {
				await relay.close();
			}
		});

		it("rejects chunks outside the stock v7 grammar and oversize chunks without failing the stream", async () => {
			const relay = factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const collecting = collect(events);

				await expect(publisher.publish("not a chunk")).rejects.toMatchObject({
					code: "invalid_event",
				});
				await expect(publisher.publish(["a"])).rejects.toMatchObject({
					code: "invalid_event",
				});
				// A custom chunk type is not part of the stock grammar.
				await expect(
					publisher.publish({ type: "turn-outcome", outcome: "done" }),
				).rejects.toMatchObject({ code: "invalid_event" });
				// A known type with a malformed shape fails the grammar too.
				await expect(
					publisher.publish({ type: "text-delta", delta: "no id" }),
				).rejects.toMatchObject({ code: "invalid_event" });
				await expect(
					publisher.publish(textDelta("x".repeat(LIVE_STREAM_MAX_EVENT_BYTES))),
				).rejects.toMatchObject({ code: "event_too_large" });

				await publisher.publish(textDelta("still-alive"));
				await publisher.publish(FINISH);
				await publisher.close();
				expect(await collecting).toEqual([textDelta("still-alive"), FINISH]);
			} finally {
				await relay.close();
			}
		});

		it("accepts data-* chunks as payload", async () => {
			const relay = factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				const events = await relay.subscribe(
					"turn-1",
					new AbortController().signal,
				);
				const collecting = collect(events);
				const dataChunk = { type: "data-widget", data: { kind: "chart" } };
				await publisher.publish(dataChunk);
				await publisher.publish(FINISH);
				await publisher.close();
				expect(await collecting).toEqual([dataChunk, FINISH]);
			} finally {
				await relay.close();
			}
		});

		it("publishes exactly one terminal chunk as the publisher's final chunk", async () => {
			const relay = factory.create();
			try {
				const publisher = relay.openPublisher("turn-1");
				await publisher.publish(textDelta("hello"));
				await publisher.publish(FINISH);
				await expect(
					publisher.publish(textDelta("late")),
				).rejects.toMatchObject({ code: "terminal_already_published" });
				await expect(
					publisher.publish({ type: "abort" }),
				).rejects.toMatchObject({ code: "terminal_already_published" });
				await publisher.close();
				await expect(
					publisher.publish(textDelta("closed")),
				).rejects.toMatchObject({ code: "producer_closed" });
			} finally {
				await relay.close();
			}
		});

		it("latches a failed publish and fails subscribers", async () => {
			const relay = factory.create({
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
					publisher.publish({ type: "text-start", id: "text-1" }),
				).rejects.toMatchObject({ code: "producer_failed" });
				await expect(publisher.publish(FINISH)).rejects.toMatchObject({
					code: "producer_failed",
				});
				expect(await subscriberFailure).toMatchObject({ code: "relay_failed" });
				await publisher.close();
			} finally {
				await relay.close();
			}
		});

		it("fails subscribers when the publisher closes without a terminal chunk", async () => {
			const relay = factory.create();
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
			const relay = factory.create();
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
