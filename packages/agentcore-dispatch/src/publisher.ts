import {
	type AgentCoreDispatchIdentity,
	MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
} from "@mymemo/agent-db/agentcore-dispatch";

export interface AgentCoreDispatchEnablementControl {
	isEnabled(): Promise<boolean>;
}

export interface AgentCoreDispatchPublisherStore {
	claim(input: {
		publisherId: string;
		runId?: string;
		limit: number;
	}): Promise<AgentCoreDispatchIdentity[]>;
	confirm(input: { runId: string; publisherId: string }): Promise<boolean>;
}

export interface AgentCoreDispatchQueue {
	send(dispatch: AgentCoreDispatchIdentity): Promise<void>;
}

export interface AgentCoreDispatchPublishResult {
	status: "enabled" | "disabled";
	publishedRunIds: string[];
	ambiguousRunIds: string[];
}

/** Claim, send, and confirm one bounded production dispatch batch. */
export function createAgentCoreDispatchPublisher(options: {
	publisherId: string;
	control: AgentCoreDispatchEnablementControl;
	store: AgentCoreDispatchPublisherStore;
	queue: AgentCoreDispatchQueue;
	signal?: AbortSignal;
}) {
	return {
		async publishPending(
			input: { runId?: string } = {},
		): Promise<AgentCoreDispatchPublishResult> {
			if (!(await options.control.isEnabled())) {
				return {
					status: "disabled",
					publishedRunIds: [],
					ambiguousRunIds: [],
				};
			}

			const claimed = await options.store.claim({
				publisherId: options.publisherId,
				runId: input.runId,
				limit: MAX_AGENTCORE_DISPATCH_PUBLISH_BATCH_SIZE,
			});
			const result: AgentCoreDispatchPublishResult = {
				status: "enabled",
				publishedRunIds: [],
				ambiguousRunIds: [],
			};
			for (const dispatch of claimed) {
				if (options.signal?.aborted) return result;
				if (!(await options.control.isEnabled())) {
					return { ...result, status: "disabled" };
				}
				if (options.signal?.aborted) return result;
				try {
					await options.queue.send(dispatch);
					const confirmed = await options.store.confirm({
						runId: dispatch.runId,
						publisherId: options.publisherId,
					});
					if (confirmed) {
						result.publishedRunIds.push(dispatch.runId);
					} else {
						result.ambiguousRunIds.push(dispatch.runId);
					}
				} catch {
					// No database write follows an ambiguous send. Its existing lease is
					// the retry delay; expiry makes the exact envelope eligible again.
					result.ambiguousRunIds.push(dispatch.runId);
				}
			}
			return result;
		},
	};
}
