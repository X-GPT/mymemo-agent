import { describe, expect, it } from "bun:test";
import {
	createEmbeddedMetricCanaryDispatchAlarm,
	loadCanaryDispatchConfigFromEnv,
	loadCanaryDispatchPublisherConfigFromEnv,
	resolveCanaryDispatchConfigFromSecretArns,
	resolveCanaryDispatchPublisherConfigFromSecretArns,
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

	it("loads the control publisher without requiring consumer-only Runtime authority", () => {
		expect(
			loadCanaryDispatchPublisherConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				AWS_REGION: "us-west-2",
				CANARY_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/canary",
				CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
			}),
		).toEqual({
			agentDatabaseUrl: "postgres://agent",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/canary",
			enabledParameterName: "/mymemo/canary/enabled",
		});
	});

	it("resolves the Lambda database URL from one exact current secret ARN", async () => {
		const secretArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:canary-agent-db-AbCdEf";
		const reads: string[] = [];
		const config = await resolveCanaryDispatchConfigFromSecretArns(
			{
				AWS_REGION: "us-west-2",
				CANARY_AGENT_DATABASE_URL_SECRET_ARN: secretArn,
				CANARY_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/canary",
				CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
				CANARY_AGENT_RUNTIME_ARN:
					"arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
			},
			async (arn) => {
				reads.push(arn);
				return "postgresql://agent.example/mymemo_agent?sslmode=verify-full";
			},
		);

		expect(reads).toEqual([secretArn]);
		expect(config.agentDatabaseUrl).toBe(
			"postgresql://agent.example/mymemo_agent?sslmode=verify-full",
		);
		await expect(
			resolveCanaryDispatchConfigFromSecretArns(
				{
					AWS_REGION: "us-west-2",
					CANARY_AGENT_DATABASE_URL_SECRET_ARN: secretArn,
					CANARY_DISPATCH_QUEUE_URL:
						"https://sqs.us-west-2.amazonaws.com/123/canary",
					CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
					CANARY_AGENT_RUNTIME_ARN:
						"arn:aws:bedrock-agentcore:us-west-2:123:runtime/canary",
				},
				async () => "postgresql://agent.example/mymemo_agent?sslmode=require",
			),
		).rejects.toThrow("AGENT_DATABASE_URL must use sslmode=verify-full");
	});

	it("resolves publisher secrets without consumer-only Runtime authority", async () => {
		const secretArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:canary-agent-db-AbCdEf";
		const config = await resolveCanaryDispatchPublisherConfigFromSecretArns(
			{
				AWS_REGION: "us-west-2",
				CANARY_AGENT_DATABASE_URL_SECRET_ARN: secretArn,
				CANARY_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/canary",
				CANARY_ENABLED_PARAMETER_NAME: "/mymemo/canary/enabled",
			},
			async () => "postgresql://agent.example/mymemo_agent?sslmode=verify-full",
		);

		expect(config).toEqual({
			agentDatabaseUrl:
				"postgresql://agent.example/mymemo_agent?sslmode=verify-full",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/canary",
			enabledParameterName: "/mymemo/canary/enabled",
		});
	});

	it("emits a bounded CloudWatch embedded metric without dispatch content", async () => {
		const records: string[] = [];
		const alarm = createEmbeddedMetricCanaryDispatchAlarm((record) => {
			records.push(record);
		});

		await alarm.raise({
			reason: "invalid_dispatch",
			messageId: "sqs-message-1",
			runId: "run-450",
		});

		expect(JSON.parse(records[0] ?? "")).toMatchObject({
			reason: "invalid_dispatch",
			messageId: "sqs-message-1",
			runId: "run-450",
			PoisonDispatch: 1,
			_aws: {
				CloudWatchMetrics: [
					{
						Dimensions: [[], ["reason"]],
						Namespace: "MyMemo/AgentCoreCanary",
						Metrics: [{ Name: "PoisonDispatch", Unit: "Count" }],
					},
				],
			},
		});
		expect(records[0]).not.toContain("prompt");
	});

	it("reports disabled retries separately from poison dispatches", async () => {
		const records: string[] = [];
		const alarm = createEmbeddedMetricCanaryDispatchAlarm((record) => {
			records.push(record);
		});

		await alarm.raise({
			reason: "disabled_delivery",
			messageId: "sqs-message-2",
		});

		expect(JSON.parse(records[0] ?? "")).toMatchObject({
			reason: "disabled_delivery",
			DisabledDelivery: 1,
			_aws: {
				CloudWatchMetrics: [
					{
						Dimensions: [[], ["reason"]],
						Namespace: "MyMemo/AgentCoreCanary",
						Metrics: [{ Name: "DisabledDelivery", Unit: "Count" }],
					},
				],
			},
		});
		expect(records[0]).not.toContain("PoisonDispatch");
	});
});
