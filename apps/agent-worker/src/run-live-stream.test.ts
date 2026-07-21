import { expect, it } from "bun:test";
import type { WorkerLogger } from "./logger";
import { RunLiveStream } from "./run-live-stream";
import { fakeLiveStreamStore } from "./testing/live-stream-store";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

it("retries a transient Live Stream failure-marker write after the Run terminalizes", async () => {
	let markerAttempts = 0;
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore({
			async append() {
				throw new Error("Redis unavailable");
			},
		}),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			markerAttempts += 1;
			if (markerAttempts === 1) throw new Error("database unavailable");
		},
		logger: silentLogger,
	});

	expect(markerAttempts).toBe(1);
	await stream.finish("done");
	expect(markerAttempts).toBe(2);
});

it.each([
	"append",
	"finalization",
] as const)("retries a transient failure-marker write after terminal %s fails", async (fault) => {
	let appendAttempts = 0;
	let finalizeAttempts = 0;
	let markerAttempts = 0;
	const stream = await RunLiveStream.open({
		store: fakeLiveStreamStore({
			async append() {
				appendAttempts += 1;
				if (fault === "append" && appendAttempts === 2) {
					throw new Error("Redis unavailable");
				}
			},
			async finalize() {
				finalizeAttempts += 1;
				if (fault === "finalization" && finalizeAttempts === 1) {
					throw new Error("Redis unavailable");
				}
			},
		}),
		runId: "run-1",
		conversationId: "conv-1",
		async markLiveStreamFailed() {
			markerAttempts += 1;
			if (markerAttempts === 1) throw new Error("database unavailable");
		},
		logger: silentLogger,
	});

	await stream.finish("done");
	expect(markerAttempts).toBe(2);
});
