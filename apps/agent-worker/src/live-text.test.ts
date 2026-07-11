import { expect, it } from "bun:test";
import { createWorkerLiveTextTransport } from "./live-text";

const logger = {
	info() {},
	warn() {},
};

it("keeps the worker Live lane disabled without valid Redis configuration", () => {
	const signals: unknown[] = [];
	const recordingLogger = {
		info(event: unknown) {
			signals.push(event);
		},
		warn() {},
	};
	expect(
		createWorkerLiveTextTransport(undefined, recordingLogger),
	).toBeUndefined();
	expect(signals).toEqual([
		{
			message: "Live preview Redis transport state changed",
			signal: "disabled",
		},
	]);
});

it("constructs the lazy production publisher when Redis is configured", async () => {
	const transport = createWorkerLiveTextTransport(
		"rediss://default:secret@redis.internal:6379",
		logger,
	);
	expect(transport).toBeDefined();
	await transport?.close();
});
