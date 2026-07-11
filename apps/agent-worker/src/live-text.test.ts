import { expect, it } from "bun:test";
import {
	createWorkerLiveTextTelemetry,
	createWorkerLiveTextTransport,
} from "./live-text";

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
		createWorkerLiveTextTransport(
			undefined,
			createWorkerLiveTextTelemetry(recordingLogger),
		),
	).toBeUndefined();
	expect(signals).toEqual([
		{
			message: "Live preview signal",
			service: "agent-worker",
			signal: "disabled",
			reason: "configuration",
			count: 1,
		},
	]);
});

it("constructs the lazy production publisher when Redis is configured", async () => {
	const transport = createWorkerLiveTextTransport(
		"rediss://default:secret@redis.internal:6379",
		createWorkerLiveTextTelemetry(logger),
	);
	expect(transport).toBeDefined();
	await transport?.close();
});
