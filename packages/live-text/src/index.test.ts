import { describe, expect, it } from "bun:test";
import {
	createLiveTextTelemetry,
	InMemoryLiveTextTransport,
	LIVE_TEXT_MAX_CHUNK_LENGTH,
	LiveTextMessageSchema,
	reportRedisLiveTextSignal,
	resolveLiveTextRedisUrl,
} from "./index";

describe("resolveLiveTextRedisUrl", () => {
	it("accepts only an authenticated TLS Redis URL", () => {
		expect(
			resolveLiveTextRedisUrl("rediss://default:secret@redis.internal:6379"),
		).toBe("rediss://default:secret@redis.internal:6379");
		expect(
			resolveLiveTextRedisUrl("rediss://:secret@redis.internal:6379"),
		).toBe("rediss://:secret@redis.internal:6379");
		for (const invalid of [
			undefined,
			"",
			"not a URL",
			"redis://default:secret@redis.internal:6379",
			"rediss://redis.internal:6379",
			"rediss://default@redis.internal:6379",
		]) {
			expect(resolveLiveTextRedisUrl(invalid)).toBeUndefined();
		}
	});

	it("allows only explicit insecure loopback configuration for local tests", () => {
		for (const redisUrl of [
			"redis://127.0.0.1:6379",
			"redis://localhost:6379",
			"redis://[::1]:6379",
		]) {
			expect(
				resolveLiveTextRedisUrl(redisUrl, { allowInsecureLoopback: true }),
			).toBe(redisUrl);
			expect(resolveLiveTextRedisUrl(redisUrl)).toBeUndefined();
		}
		expect(
			resolveLiveTextRedisUrl("redis://redis.internal:6379", {
				allowInsecureLoopback: true,
			}),
		).toBeUndefined();
	});
});

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

		expect(subscription.readDroppedMessages()).toEqual({
			type: "message_ids",
			messageIds: ["message-1"],
		});
		expect(subscription.readDroppedMessages()).toEqual({
			type: "message_ids",
			messageIds: [],
		});
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

		expect(subscription.readDroppedMessages()).toEqual({
			type: "tracking_overflow",
		});
		expect(subscription.readDroppedMessages()).toEqual({
			type: "message_ids",
			messageIds: [],
		});
	});
});

describe("reportRedisLiveTextSignal", () => {
	it("maps every Redis transport signal to a bounded payload-free event", () => {
		const events: Record<string, unknown>[] = [];
		const telemetry = createLiveTextTelemetry("agent-worker", {
			info: (event) => events.push(event),
			warn: (event) => events.push(event),
		});

		for (const signal of [
			"degraded",
			"recovered",
			"invalid_message",
			"oversized_message",
		] as const) {
			reportRedisLiveTextSignal(telemetry, signal);
		}

		expect(
			events.map(({ signal, reason, outcome }) => ({
				signal,
				reason,
				outcome,
			})),
		).toEqual([
			{ signal: "degraded", reason: "redis_connection", outcome: undefined },
			{ signal: "recovered", reason: "redis_connection", outcome: undefined },
			{ signal: "malformed", reason: "adapter_message", outcome: "dropped" },
			{ signal: "malformed", reason: "adapter_message", outcome: "dropped" },
		]);
		telemetry.close();
	});
});
