import { describe, expect, it } from "bun:test";
import {
	createEmbeddedMetricCanaryDispatchAlarm,
	loadCanaryDispatchConfigFromEnv,
} from "./production";

describe("Canary dispatch production configuration", () => {
	it("loads every queue/control/Runtime authority from deployment environment", () => {
		expect(
			loadCanaryDispatchConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				AWS_REGION: "us-west-2",
				CANARY_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/canary",
				CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
				CANARY_AGENT_RUNTIME_ARN:
					"arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
			}),
		).toEqual({
			agentDatabaseUrl: "postgres://agent",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/canary",
			enabledParameterName: "/mymemo/canary/enabled",
			agentRuntimeArn: "arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
		});
		expect(() => loadCanaryDispatchConfigFromEnv({})).toThrow(
			"AGENT_DATABASE_URL is required",
		);
	});

	it("emits a bounded CloudWatch embedded metric without dispatch content", async () => {
		const records: string[] = [];
		const alarm = createEmbeddedMetricCanaryDispatchAlarm((record) => {
			records.push(record);
		});

		await alarm.raise({
			reason: "invalid_dispatch",
			messageId: "sqs-message-1",
			dispatchId: "dispatch-450",
		});

		expect(JSON.parse(records[0] ?? "")).toMatchObject({
			reason: "invalid_dispatch",
			messageId: "sqs-message-1",
			dispatchId: "dispatch-450",
			PoisonDispatch: 1,
			_aws: {
				CloudWatchMetrics: [
					{
						Namespace: "MyMemo/AgentCoreCanary",
						Metrics: [{ Name: "PoisonDispatch", Unit: "Count" }],
					},
				],
			},
		});
		expect(records[0]).not.toContain("prompt");
	});
});
