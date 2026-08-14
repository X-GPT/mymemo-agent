import type { CanaryDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import { CANARY_QUEUE_INVARIANTS } from "./invariants";

export interface CanaryEnablementControl {
	isEnabled(): Promise<boolean>;
}

export interface CanaryDispatchPublisherStore {
	markOverdue(): Promise<{ campaignIds: string[] }>;
	claim(input: {
		publisherId: string;
		dispatchId?: string;
		limit: number;
	}): Promise<CanaryDispatchIdentity[]>;
	confirm(input: { dispatchId: string; publisherId: string }): Promise<boolean>;
}

export interface CanaryDispatchQueue {
	send(dispatch: CanaryDispatchIdentity): Promise<void>;
}

export interface CanaryPublishResult {
	status: "enabled" | "disabled";
	overdueCampaignIds: string[];
	publishedDispatchIds: string[];
	ambiguousDispatchIds: string[];
}

/** Shared by the immediate launcher attempt and the minute repair invocation. */
export function createCanaryDispatchPublisher(options: {
	publisherId: string;
	control: CanaryEnablementControl;
	store: CanaryDispatchPublisherStore;
	queue: CanaryDispatchQueue;
}) {
	return {
		async publishPending(
			input: { dispatchId?: string } = {},
		): Promise<CanaryPublishResult> {
			const overdue = await options.store.markOverdue();
			if (!(await options.control.isEnabled())) {
				return {
					status: "disabled",
					overdueCampaignIds: overdue.campaignIds,
					publishedDispatchIds: [],
					ambiguousDispatchIds: [],
				};
			}

			const claimed = await options.store.claim({
				publisherId: options.publisherId,
				dispatchId: input.dispatchId,
				limit: CANARY_QUEUE_INVARIANTS.publisherBatchSize,
			});
			const result: CanaryPublishResult = {
				status: "enabled",
				overdueCampaignIds: overdue.campaignIds,
				publishedDispatchIds: [],
				ambiguousDispatchIds: [],
			};
			for (const dispatch of claimed) {
				if (!(await options.control.isEnabled())) {
					return { ...result, status: "disabled" };
				}
				try {
					await options.queue.send(dispatch);
					const confirmed = await options.store.confirm({
						dispatchId: dispatch.dispatchId,
						publisherId: options.publisherId,
					});
					if (confirmed) {
						result.publishedDispatchIds.push(dispatch.dispatchId);
					} else {
						result.ambiguousDispatchIds.push(dispatch.dispatchId);
					}
				} catch {
					// No database write follows an ambiguous send. Its existing lease is
					// the retry delay; expiry makes the exact envelope eligible again.
					result.ambiguousDispatchIds.push(dispatch.dispatchId);
				}
			}
			return result;
		},
	};
}
