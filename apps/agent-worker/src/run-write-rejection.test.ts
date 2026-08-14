import { describe, expect, it } from "bun:test";
import type { RunWriteRejected } from "@mymemo/agent-db/run-store";
import { classifyRunWriteRejection } from "./run-write-rejection";

describe("classifyRunWriteRejection", () => {
	it.each([
		[
			{ outcome: "rejected", rejected: "status", current: "done" },
			{ type: "status", current: "done" },
		],
		[
			{ outcome: "rejected", rejected: "lease" },
			{ type: "ownership_lost", reason: "lease" },
		],
		[
			{ outcome: "rejected", rejected: "gone" },
			{ type: "ownership_lost", reason: "gone" },
		],
	] as const)("classifies %o", (rejection, expected) => {
		expect(classifyRunWriteRejection(rejection as RunWriteRejected)).toEqual(
			expected,
		);
	});
});
