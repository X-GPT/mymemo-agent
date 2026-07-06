import { describe, expect, it } from "bun:test";
import {
	DescribeServicesCommand,
	ListTagsForResourceCommand,
	type TagResourceCommand,
} from "@aws-sdk/client-ecs";
import { EcsServiceStateStore } from "./ecs-state-store";

describe("EcsServiceStateStore", () => {
	it("reads current desired count and the last scale-in tag from ECS", async () => {
		const client = new FakeEcsStateClient({
			desiredCount: 6,
			tags: [
				{
					key: "mymemo-agent:last-scale-in-at",
					value: "2026-01-01T00:00:00.000Z",
				},
			],
		});
		const store = new EcsServiceStateStore({
			cluster: "cluster-1",
			service: "service-1",
			client,
		});

		await expect(store.readState()).resolves.toEqual({
			currentDesiredTasks: 6,
			lastScaleInAt: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(client.describeInputs).toEqual([
			{ cluster: "cluster-1", services: ["service-1"] },
		]);
		expect(client.listTagInputs).toEqual([
			{ resourceArn: "arn:aws:ecs:us-west-2:123:service/cluster-1/service-1" },
		]);
	});

	it("records scale-in time as an ECS service tag", async () => {
		const client = new FakeEcsStateClient({ desiredCount: 6, tags: [] });
		const store = new EcsServiceStateStore({
			cluster: "cluster-1",
			service: "service-1",
			client,
		});

		await store.writeState({
			currentDesiredTasks: 3,
			lastScaleInAt: new Date("2026-01-01T00:00:00.000Z"),
		});

		expect(client.tagInputs).toEqual([
			{
				resourceArn: "arn:aws:ecs:us-west-2:123:service/cluster-1/service-1",
				tags: [
					{
						key: "mymemo-agent:last-scale-in-at",
						value: "2026-01-01T00:00:00.000Z",
					},
				],
			},
		]);
	});
});

class FakeEcsStateClient {
	readonly describeInputs: unknown[] = [];
	readonly listTagInputs: unknown[] = [];
	readonly tagInputs: unknown[] = [];

	constructor(
		private readonly state: {
			desiredCount: number;
			tags: Array<{ key: string; value: string }>;
		},
	) {}

	async send(
		command:
			| DescribeServicesCommand
			| ListTagsForResourceCommand
			| TagResourceCommand,
	): Promise<unknown> {
		if (command instanceof DescribeServicesCommand) {
			this.describeInputs.push(command.input);
			return {
				services: [
					{
						serviceArn: "arn:aws:ecs:us-west-2:123:service/cluster-1/service-1",
						desiredCount: this.state.desiredCount,
					},
				],
			};
		}
		if (command instanceof ListTagsForResourceCommand) {
			this.listTagInputs.push(command.input);
			return { tags: this.state.tags };
		}
		this.tagInputs.push(command.input);
		return {};
	}
}
