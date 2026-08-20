import { randomUUID } from "node:crypto";
import {
	type AcquireAgentCoreDispatchResult,
	type AgentCoreDispatchIdentity,
	acquireAgentCoreDispatchTx,
} from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import type { AgentCoreDispatchEnablementControl } from "@mymemo/agentcore-dispatch/publisher";
import {
	createAcquisitionReceipt,
	parseAgentCoreDispatchEnvelope,
} from "./contract";

export type AgentCoreDispatchAcquirer = (input: {
	dispatch: AgentCoreDispatchIdentity;
	workerId: string;
}) => Promise<AcquireAgentCoreDispatchResult>;

export interface CommittedAgentCoreAcquisition {
	dispatch: AgentCoreDispatchIdentity;
	result: AcquireAgentCoreDispatchResult;
	receiptLine: string;
}

export function createAgentCoreAcquisitionBoundary(options: {
	control: AgentCoreDispatchEnablementControl;
	acquire: AgentCoreDispatchAcquirer;
	createWorkerId: () => string;
	now?: () => Date;
}) {
	async function assertEnabled(): Promise<void> {
		if (!(await options.control.isEnabled())) {
			throw new Error("AgentCore dispatch is disabled");
		}
	}

	async function commitDispatch(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<CommittedAgentCoreAcquisition> {
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
	): Promise<CommittedAgentCoreAcquisition> {
		await assertEnabled();
		return await commitDispatch(parseAgentCoreDispatchEnvelope(rawEnvelope));
	}

	async function acquireDispatch(
		dispatch: AgentCoreDispatchIdentity,
	): Promise<CommittedAgentCoreAcquisition> {
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

export function createDatabaseAgentCoreAcquisitionBoundary(options: {
	db: Database;
	bootId: string;
	control: AgentCoreDispatchEnablementControl;
	now?: () => Date;
}) {
	return createAgentCoreAcquisitionBoundary({
		control: options.control,
		acquire: async (input) =>
			await acquireAgentCoreDispatchTx(options.db, input),
		createWorkerId: () => `${options.bootId}/${randomUUID()}`,
		now: options.now,
	});
}
