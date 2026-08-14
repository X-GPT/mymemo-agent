import { randomUUID } from "node:crypto";
import {
	type AcquireCanaryDispatchResult,
	acquireCanaryDispatchTx,
	type CanaryDispatchIdentity,
} from "@mymemo/agent-db/canary-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import {
	createAcquisitionReceipt,
	parseCanaryDispatchEnvelope,
} from "./contract";
import type { CanaryEnablementControl } from "./publisher";

export type CanaryDispatchAcquirer = (input: {
	dispatch: CanaryDispatchIdentity;
	workerId: string;
}) => Promise<AcquireCanaryDispatchResult>;

export function createCanaryAcquisitionBoundary(options: {
	control: CanaryEnablementControl;
	acquire: CanaryDispatchAcquirer;
	createWorkerId: () => string;
	now?: () => Date;
}) {
	return {
		async handle(rawEnvelope: string): Promise<string> {
			if (!(await options.control.isEnabled())) {
				throw new Error("Canary dispatch is disabled");
			}
			const dispatch = parseCanaryDispatchEnvelope(rawEnvelope);
			const workerId = options.createWorkerId();
			// Awaiting this promise is the commit boundary. Receipt construction and
			// emission are deliberately impossible before it resolves.
			const result = await options.acquire({ dispatch, workerId });
			const receipt = createAcquisitionReceipt(
				dispatch,
				result,
				(options.now ?? (() => new Date()))(),
			);
			return `${JSON.stringify(receipt)}\n`;
		},
	};
}

export function createDatabaseCanaryAcquisitionBoundary(options: {
	db: Database;
	bootId: string;
	control: CanaryEnablementControl;
	now?: () => Date;
}) {
	return createCanaryAcquisitionBoundary({
		control: options.control,
		acquire: async (input) => await acquireCanaryDispatchTx(options.db, input),
		createWorkerId: () => `${options.bootId}/${randomUUID()}`,
		now: options.now,
	});
}
