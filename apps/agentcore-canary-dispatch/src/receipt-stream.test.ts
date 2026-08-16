import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { createAcquisitionReceipt } from "./contract";
import { readAcquisitionReceipt } from "./receipt-stream";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	runId: "run-450",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045001",
	admittedAt: new Date("2026-08-14T16:00:00.000Z"),
};

async function* chunks(parts: string[]): AsyncIterable<Uint8Array> {
	for (const part of parts) yield new TextEncoder().encode(part);
}

describe("incremental Acquisition receipt parsing", () => {
	it("returns the first strict receipt as soon as its newline arrives across arbitrary chunks", async () => {
		const receipt = createAcquisitionReceipt(
			dispatch,
			{ disposition: "terminal", status: "done" },
			new Date("2026-08-14T16:01:00.000Z"),
		);
		const wire = `${JSON.stringify(receipt)}\n`;

		await expect(
			readAcquisitionReceipt(
				chunks([wire.slice(0, 7), wire.slice(7, 41), wire.slice(41)]),
			),
		).resolves.toEqual(receipt);
	});
});
