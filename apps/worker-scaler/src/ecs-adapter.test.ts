import { describe, expect, it } from "bun:test";
import type { UpdateServiceCommand } from "@aws-sdk/client-ecs";
import { EcsUpdateServiceAdapter } from "./ecs-adapter";

describe("EcsUpdateServiceAdapter", () => {
	it("isolates ECS UpdateService behind a tiny desired-count adapter", async () => {
		const sentCommands: UpdateServiceCommand[] = [];
		const adapter = new EcsUpdateServiceAdapter(
			{
				async send(command: UpdateServiceCommand) {
					sentCommands.push(command);
					return {};
				},
			},
			{
				cluster: "cluster-1",
				service: "service-1",
			},
		);

		await adapter.updateDesiredCount(4);

		expect(sentCommands).toHaveLength(1);
		expect(sentCommands[0]?.input).toEqual({
			cluster: "cluster-1",
			service: "service-1",
			desiredCount: 4,
		});
	});
});
