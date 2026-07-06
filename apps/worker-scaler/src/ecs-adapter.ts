import { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import type { DesiredCountAdapter } from "./scaler";

export interface EcsServiceTarget {
	cluster: string;
	service: string;
}

export interface EcsUpdateServiceClient {
	send(command: UpdateServiceCommand): Promise<unknown>;
}

/**
 * Thin boundary around the AWS ECS control-plane write. The scaler computes a
 * desired count; this adapter is the only place that knows it becomes
 * `UpdateService({ desiredCount })`.
 */
export class EcsUpdateServiceAdapter implements DesiredCountAdapter {
	constructor(
		private readonly client: EcsUpdateServiceClient,
		private readonly target: EcsServiceTarget,
	) {}

	async updateDesiredCount(desiredTasks: number): Promise<void> {
		await this.client.send(
			new UpdateServiceCommand({
				cluster: this.target.cluster,
				service: this.target.service,
				desiredCount: desiredTasks,
			}),
		);
	}
}
