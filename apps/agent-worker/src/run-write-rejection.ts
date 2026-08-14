import type { RunWriteRejected } from "@mymemo/agent-db/run-store";

export type OwnershipLossReason = Exclude<
	RunWriteRejected["rejected"],
	"status"
>;
export type OwnershipLossSource = "heartbeat" | "write";

export interface OwnershipLoss {
	reason: OwnershipLossReason;
	source: OwnershipLossSource;
}

export type ClassifiedRunWriteRejection =
	| {
			type: "status";
			current: Extract<RunWriteRejected, { rejected: "status" }>["current"];
	  }
	| { type: "ownership_lost"; reason: OwnershipLossReason };

/** Keep the shared Run-write rejection vocabulary classified in one place;
 * each runtime layer still owns the different action that classification means. */
export function classifyRunWriteRejection(
	rejection: RunWriteRejected,
): ClassifiedRunWriteRejection {
	if (rejection.rejected === "status") {
		return { type: "status", current: rejection.current };
	}
	return { type: "ownership_lost", reason: rejection.rejected };
}
