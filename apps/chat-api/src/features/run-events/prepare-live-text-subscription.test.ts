import { expect, it } from "bun:test";
import type { LiveTextSubscription } from "@mymemo/live-text";
import { prepareLiveTextSubscription } from "./prepare-live-text-subscription";

it("falls back when subscription setup throws synchronously", async () => {
	await expect(
		prepareLiveTextSubscription(
			{
				subscribe() {
					throw new Error("client is unavailable");
				},
			},
			"run-1",
		),
	).resolves.toBeNull();
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
		1,
	);

	await expect(prepared).resolves.toBeNull();
	resolveSubscription?.({
		readAvailable: () => [],
		waitForMessage: async () => false,
		close: async () => {
			closes++;
		},
	});
	await Bun.sleep(0);
	expect(closes).toBe(1);
});
