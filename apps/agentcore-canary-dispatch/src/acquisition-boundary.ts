import { randomUUID } from "node:crypto";
import {
	type AcquireAgentCoreDispatchResult,
	type AgentCoreDispatchIdentity,
	acquireAgentCoreDispatchTx,
} from "@mymemo/agent-db/canary-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import {
	createAcquisitionReceipt,
	parseCanaryDispatchEnvelope,
} from "./contract";
import type { CanaryEnablementControl } from "./publisher";

export type CanaryDispatchAcquirer = (input: {
	dispatch: AgentCoreDispatchIdentity;
	workerId: string;
}) => Promise<AcquireAgentCoreDispatchResult>;

export interface CommittedCanaryAcquisition {
	dispatch: AgentCoreDispatchIdentity;
	result: AcquireAgentCoreDispatchResult;
	receiptLine: string;
}

export function createCanaryAcquisitionBoundary(options: {
	control: CanaryEnablementControl;
	acquire: CanaryDispatchAcquirer;
	createWorkerId: () => string;
	now?: () => Date;
}) {
	async function assertEnabled(): Promise<void> {
		if (!(await options.control.isEnabled())) {
			throw new Error("Canary dispatch is disabled");
		}
	}

	async function commitDispatch(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<CommittedCanaryAcquisition> {
		const workerId = options.createWorkerId();
		// Awaiting this promise is the commit boundary. Receipt construction and
		// emission are deliberately impossible before it resolves.
		const result = await options.acquire({ dispatch, workerId });
		const receipt = createAcquisitionReceipt(
			dispatch,
			result,
			(options.now ?? (() => new Date()))(),
		);
		return {
			dispatch,
			result,
			receiptLine: `${JSON.stringify(receipt)}\n`,
		};
	}

	async function acquire(
		rawEnvelope: string,
	): Promise<CommittedCanaryAcquisition> {
		await assertEnabled();
		return await commitDispatch(parseCanaryDispatchEnvelope(rawEnvelope));
	}

	async function acquireDispatch(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<CommittedCanaryAcquisition> {
		await assertEnabled();
		return await commitDispatch(dispatch);
	}

	return {
		acquire,
		acquireDispatch,
		async handle(rawEnvelope: string): Promise<string> {
			return (await acquire(rawEnvelope)).receiptLine;
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
		acquire: async (input) =>
			await acquireAgentCoreDispatchTx(options.db, input),
		createWorkerId: () => `${options.bootId}/${randomUUID()}`,
		now: options.now,
	});
}
