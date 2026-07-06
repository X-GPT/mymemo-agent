import {
	DescribeServicesCommand,
	ListTagsForResourceCommand,
	TagResourceCommand,
} from "@aws-sdk/client-ecs";
import type { ScalerStateStore, WorkerScalerState } from "./scaler";

const DEFAULT_LAST_SCALE_IN_TAG = "mymemo-agent:last-scale-in-at";

export interface EcsStateStoreClient {
	send(
		command:
			| DescribeServicesCommand
			| ListTagsForResourceCommand
			| TagResourceCommand,
	): Promise<unknown>;
}

export interface EcsServiceStateStoreOptions {
	cluster: string;
	service: string;
	client: EcsStateStoreClient;
	lastScaleInTag?: string;
}

export class EcsServiceStateStore implements ScalerStateStore {
	private readonly cluster: string;
	private readonly service: string;
	private readonly client: EcsStateStoreClient;
	private readonly lastScaleInTag: string;
	private serviceArn: string | null = null;

	constructor(options: EcsServiceStateStoreOptions) {
		this.cluster = options.cluster;
		this.service = options.service;
		this.client = options.client;
		this.lastScaleInTag = options.lastScaleInTag ?? DEFAULT_LAST_SCALE_IN_TAG;
	}

	async readState(): Promise<WorkerScalerState> {
		const service = await this.describeService();
		const tagsResponse = (await this.client.send(
			new ListTagsForResourceCommand({ resourceArn: service.serviceArn }),
		)) as {
			tags?: Array<{ key?: string; value?: string }>;
		};
		const rawLastScaleInAt = tagsResponse.tags?.find(
			(tag) => tag.key === this.lastScaleInTag,
		)?.value;

		return {
			currentDesiredTasks: service.desiredCount,
			lastScaleInAt: parseDateOrNull(rawLastScaleInAt),
		};
	}

	async writeState(next: WorkerScalerState): Promise<void> {
		if (!next.lastScaleInAt) return;
		const serviceArn =
			this.serviceArn ?? (await this.describeService()).serviceArn;
		await this.client.send(
			new TagResourceCommand({
				resourceArn: serviceArn,
				tags: [
					{
						key: this.lastScaleInTag,
						value: next.lastScaleInAt.toISOString(),
					},
				],
			}),
		);
	}

	private async describeService(): Promise<{
		serviceArn: string;
		desiredCount: number;
	}> {
		const response = (await this.client.send(
			new DescribeServicesCommand({
				cluster: this.cluster,
				services: [this.service],
			}),
		)) as {
			services?: Array<{
				serviceArn?: string;
				desiredCount?: number;
			}>;
		};
		const service = response.services?.[0];
		if (!service?.serviceArn) {
			throw new Error(`ECS service ${this.service} was not found`);
		}
		this.serviceArn = service.serviceArn;
		return {
			serviceArn: service.serviceArn,
			desiredCount: service.desiredCount ?? 0,
		};
	}
}

function parseDateOrNull(value: string | undefined): Date | null {
	if (!value) return null;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) ? date : null;
}
