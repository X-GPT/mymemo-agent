import { expect, it } from "bun:test";
import {
	InMemoryLiveTextTransport,
	type LiveTextMessage,
} from "@mymemo/live-text";
import { LiveTextPreview } from "./live-text-preview";

function deferred<T>() {
	let resolve: (value: T | PromiseLike<T>) => void = () => {};
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

it("publishes coalesced chunks with monotonic indexes within the 50 ms ceiling", async () => {
	const transport = new InMemoryLiveTextTransport();
	const subscription = await transport.subscribe("run-1");
	const preview = new LiveTextPreview({
		runId: "run-1",
		publisher: transport,
		coalesceWindowMs: 5,
	});

	preview.append("message-1", "A");
	await Bun.sleep(10);
	preview.append("message-1", "B");
	await preview.flushMessage();

	expect(subscription.readAvailable()).toEqual([
		{
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 0,
			text: "A",
		},
		{
			runId: "run-1",
			messageId: "message-1",
			deltaIndex: 1,
			text: "B",
		},
	]);
	expect(
		() =>
			new LiveTextPreview({
				runId: "run-1",
				publisher: transport,
				coalesceWindowMs: 51,
			}),
	).toThrow("between 0 and 50 ms");
});

it("abandons only the current preview after publication fails", async () => {
	const published: LiveTextMessage[] = [];
	let attempts = 0;
	const preview = new LiveTextPreview({
		runId: "run-1",
		publisher: {
			async publish(message) {
				attempts++;
				if (attempts === 1) throw new Error("transport unavailable");
				published.push(message);
			},
		},
	});

	preview.append("message-1", "lost");
	await preview.flushMessage();
	preview.append("message-2", "visible");
	await preview.flushMessage();

	expect(published).toEqual([
		{ messageId: "message-2", deltaIndex: 0, text: "visible", runId: "run-1" },
	]);
});

it("does not wait for a stalled publisher when a message completes", async () => {
	const stalled = deferred<void>();
	const started = deferred<void>();
	const preview = new LiveTextPreview({
		runId: "run-1",
		publisher: {
			async publish() {
				started.resolve();
				await stalled.promise;
			},
		},
	});

	preview.append("message-1", "complete");
	const flushed = preview.flushMessage();
	await started.promise;

	expect(
		await Promise.race([
			flushed.then(() => "flushed"),
			Bun.sleep(10).then(() => "blocked"),
		]),
	).toBe("flushed");
	stalled.resolve();
});

it("bounds queued publications and recovers on the next Assistant message", async () => {
	const firstPublish = deferred<void>();
	const published: LiveTextMessage[] = [];
	const signals: string[] = [];
	let attempts = 0;
	const preview = new LiveTextPreview({
		runId: "run-1",
		maxQueuedMessages: 1,
		onSignal: (signal) => signals.push(signal),
		publisher: {
			async publish(message) {
				attempts++;
				if (attempts === 1) await firstPublish.promise;
				published.push(message);
			},
		},
	});

	preview.append("message-1", "A".repeat(16_384 * 3));
	await preview.flushMessage();
	firstPublish.resolve();
	await Bun.sleep(0);
	preview.append("message-2", "visible");
	await preview.flushMessage();
	await Bun.sleep(0);

	expect(signals).toEqual(["queue_overflow", "recovered"]);
	expect(published.map(({ messageId, text }) => ({ messageId, text }))).toEqual(
		[
			{ messageId: "message-1", text: "A".repeat(16_384) },
			{ messageId: "message-2", text: "visible" },
		],
	);
});

it("aborts an outstanding publication and releases its queue on close", async () => {
	const aborted = deferred<void>();
	const preview = new LiveTextPreview({
		runId: "run-1",
		publisher: {
			async publish(_message, options) {
				await new Promise<void>((resolve) => {
					options?.signal?.addEventListener(
						"abort",
						() => {
							aborted.resolve();
							resolve();
						},
						{ once: true },
					);
				});
			},
		},
	});

	preview.append("message-1", "pending");
	await preview.flushMessage();
	preview.close();

	await expect(aborted.promise).resolves.toBeUndefined();
});
