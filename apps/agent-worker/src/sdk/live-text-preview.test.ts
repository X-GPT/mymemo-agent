import { expect, it } from "bun:test";
import {
	InMemoryLiveTextTransport,
	type LiveTextMessage,
} from "@mymemo/live-text";
import { LiveTextPreview } from "./live-text-preview";

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
