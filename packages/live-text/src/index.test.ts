import { describe, expect, it } from "bun:test";
import {
	InMemoryLiveTextTransport,
	LIVE_TEXT_MAX_CHUNK_LENGTH,
	LiveTextMessageSchema,
} from "./index";

describe("LiveTextMessageSchema", () => {
	it("accepts the bounded provisional wire message and rejects extra or oversized data", () => {
		expect(
			LiveTextMessageSchema.parse({
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 0,
				text: "hello",
			}),
		).toEqual({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "hello",
		});
		expect(
			LiveTextMessageSchema.safeParse({
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 0,
				text: "x".repeat(LIVE_TEXT_MAX_CHUNK_LENGTH + 1),
			}),
		).toMatchObject({ success: false });
		expect(
			LiveTextMessageSchema.safeParse({
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 0,
				text: "hello",
				durable: true,
			}),
		).toMatchObject({ success: false });
	});
});

describe("InMemoryLiveTextTransport", () => {
	it("buffers ordered messages only for subscriptions prepared on that Run", async () => {
		const transport = new InMemoryLiveTextTransport();
		const runOne = await transport.subscribe("run-1");
		const runTwo = await transport.subscribe("run-2");

		await transport.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "hel",
		});
		await transport.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 1,
			text: "lo",
		});

		expect(runOne.readAvailable()).toEqual([
			{
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 0,
				text: "hel",
			},
			{
				runId: "run-1",
				messageId: "message-1",
				deltaIndex: 1,
				text: "lo",
			},
		]);
		expect(runTwo.readAvailable()).toEqual([]);

		await runOne.close();
		await transport.publish({
			runId: "run-1",
			messageId: "message-2",
			deltaIndex: 0,
			text: "ignored",
		});
		expect(runOne.readAvailable()).toEqual([]);
	});

	it("releases a pending waiter as unavailable when its subscription closes", async () => {
		const transport = new InMemoryLiveTextTransport();
		const subscription = await transport.subscribe("run-1");
		const waiting = subscription.waitForMessage();

		await subscription.close();

		await expect(waiting).resolves.toBe(false);
	});

	it("reports dropped message ids when the per-connection buffer overflows", async () => {
		const transport = new InMemoryLiveTextTransport(1);
		const subscription = await transport.subscribe("run-1");

		await transport.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "prefix",
		});
		await transport.publish({
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 1,
			text: "dropped",
		});

		expect(subscription.readDroppedMessageIds?.()).toEqual(["message-1"]);
		expect(subscription.readDroppedMessageIds?.()).toEqual([]);
		expect(subscription.readAvailable()).toHaveLength(1);
	});

	it("bounds dropped-id tracking when many messages overflow one connection", async () => {
		const transport = new InMemoryLiveTextTransport(1);
		const subscription = await transport.subscribe("run-1");
		await transport.publish({
			runId: "run-1",
			messageId: "buffered",
			deltaIndex: 0,
			text: "buffered",
		});
		for (const messageId of ["dropped-1", "dropped-2"]) {
			await transport.publish({
				runId: "run-1",
				messageId,
				deltaIndex: 0,
				text: "dropped",
			});
		}

		expect(subscription.readDroppedMessageIds?.()).toBeNull();
		expect(subscription.readDroppedMessageIds?.()).toEqual([]);
	});
});
