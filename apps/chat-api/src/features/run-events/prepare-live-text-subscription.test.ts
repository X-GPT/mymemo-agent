import { expect, it } from "bun:test";
import {
	disabledLiveTextSubscriber,
	type LiveTextSubscription,
} from "@mymemo/live-text";
import { prepareLiveTextSubscription } from "./prepare-live-text-subscription";

it("falls back when subscription setup throws synchronously", async () => {
	const signals: string[] = [];
	await expect(
		prepareLiveTextSubscription(
			{
				subscribe() {
					throw new Error("client is unavailable");
				},
			},
			"run-1",
			{
				onSignal: (signal) => {
					signals.push(signal);
					throw new Error("telemetry unavailable");
				},
			},
		),
	).resolves.toBeNull();
	expect(signals).toEqual(["degraded"]);
});

it("reports disabled configuration without surfacing an error", async () => {
	const signals: string[] = [];

	await expect(
		prepareLiveTextSubscription(disabledLiveTextSubscriber, "run-1", {
			onSignal: (signal) => signals.push(signal),
		}),
	).resolves.toBeNull();
	expect(signals).toEqual(["disabled"]);
});

it("falls back after a bounded wait and closes a subscription that arrives late", async () => {
	let resolveSubscription: ((value: LiveTextSubscription) => void) | undefined;
	let closes = 0;
	const prepared = prepareLiveTextSubscription(
		{
			async subscribe() {
				return new Promise<LiveTextSubscription>((resolve) => {
					resolveSubscription = resolve;
				});
			},
		},
		"run-1",
		{ timeoutMs: 1 },
	);

	await expect(prepared).resolves.toBeNull();
	resolveSubscription?.({
		readAvailable: () => [],
		readDroppedMessages: () => ({ type: "message_ids", messageIds: [] }),
		waitForMessage: async () => false,
		close: async () => {
			closes++;
		},
	});
	await Bun.sleep(0);
	expect(closes).toBe(1);
});
