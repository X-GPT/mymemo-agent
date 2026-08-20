import { describe, expect, it } from "bun:test";
import {
	createEmbeddedMetricAgentCoreDispatchAlarm,
	loadAgentCoreDispatchConfigFromEnv,
	loadAgentCoreDispatchPublisherConfigFromEnv,
	resolveAgentCoreDispatchConfigFromSecretArns,
	resolveAgentCoreDispatchPublisherConfigFromSecretArns,
} from "./production";

describe("AgentCore dispatch production configuration", () => {
	it("loads every queue/control/Runtime authority from deployment environment", () => {
		expect(
			loadAgentCoreDispatchConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				AWS_REGION: "us-west-2",
				AGENTCORE_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/agentcore",
				AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
					"/mymemo/agentcore-dispatch/prod/enabled",
				AGENTCORE_RUNTIME_ARN:
					"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
			}),
		).toEqual({
			agentDatabaseUrl: "postgres://agent",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/agentcore",
			enabledParameterName: "/mymemo/agentcore-dispatch/prod/enabled",
			agentRuntimeArn:
				"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
		});
		expect(() => loadAgentCoreDispatchConfigFromEnv({})).toThrow(
			"AGENT_DATABASE_URL is required",
		);
	});

	it("loads the control publisher without requiring consumer-only Runtime authority", () => {
		expect(
			loadAgentCoreDispatchPublisherConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				AWS_REGION: "us-west-2",
				AGENTCORE_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/agentcore",
				AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
					"/mymemo/agentcore-dispatch/prod/enabled",
			}),
		).toEqual({
			agentDatabaseUrl: "postgres://agent",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/agentcore",
			enabledParameterName: "/mymemo/agentcore-dispatch/prod/enabled",
		});
	});

	it("resolves the Lambda database URL from the worker URL and current RDS password secret", async () => {
		const passwordSecretArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-password-AbCdEf";
		const reads: string[] = [];
		const config = await resolveAgentCoreDispatchConfigFromSecretArns(
			{
				AWS_REGION: "us-west-2",
				AGENT_DATABASE_URL:
					"postgresql://mymemo_agent@agent.example/mymemo_agent",
				DB_PASSWORD_SECRET_ARN: passwordSecretArn,
				AGENTCORE_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/agentcore",
				AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
					"/mymemo/agentcore-dispatch/prod/enabled",
				AGENTCORE_RUNTIME_ARN:
					"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
			},
			async (arn) => {
				reads.push(arn);
				return JSON.stringify({ password: "agent-secret" });
			},
		);

		expect(reads).toEqual([passwordSecretArn]);
		expect(config.agentDatabaseUrl).toBe(
			"postgresql://mymemo_agent:agent-secret@agent.example/mymemo_agent?sslmode=verify-full",
		);
		await expect(
			resolveAgentCoreDispatchConfigFromSecretArns(
				{
					AWS_REGION: "us-west-2",
					AGENT_DATABASE_URL:
						"postgresql://mymemo_agent@agent.example/mymemo_agent",
					DB_PASSWORD_SECRET_ARN: passwordSecretArn,
					AGENTCORE_DISPATCH_QUEUE_URL:
						"https://sqs.us-west-2.amazonaws.com/123/agentcore",
					AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
						"/mymemo/agentcore-dispatch/prod/enabled",
					AGENTCORE_RUNTIME_ARN:
						"arn:aws:bedrock-agentcore:us-west-2:123:runtime/agentcore",
				},
				async () => "not-json",
			),
		).rejects.toThrow("DB_PASSWORD secret must contain a JSON password");
	});

	it("resolves publisher secrets without consumer-only Runtime authority", async () => {
		const passwordSecretArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-password-AbCdEf";
		const config = await resolveAgentCoreDispatchPublisherConfigFromSecretArns(
			{
				AWS_REGION: "us-west-2",
				AGENT_DATABASE_URL:
					"postgresql://mymemo_agent@agent.example/mymemo_agent",
				DB_PASSWORD_SECRET_ARN: passwordSecretArn,
				AGENTCORE_DISPATCH_QUEUE_URL:
					"https://sqs.us-west-2.amazonaws.com/123/agentcore",
				AGENTCORE_DISPATCH_ENABLED_PARAMETER_NAME:
					"/mymemo/agentcore-dispatch/prod/enabled",
			},
			async () => JSON.stringify({ password: "agent-secret" }),
		);

		expect(config).toEqual({
			agentDatabaseUrl:
				"postgresql://mymemo_agent:agent-secret@agent.example/mymemo_agent?sslmode=verify-full",
			awsRegion: "us-west-2",
			queueUrl: "https://sqs.us-west-2.amazonaws.com/123/agentcore",
			enabledParameterName: "/mymemo/agentcore-dispatch/prod/enabled",
		});
	});

	it("emits a bounded CloudWatch embedded metric without dispatch content", async () => {
		const records: string[] = [];
		const alarm = createEmbeddedMetricAgentCoreDispatchAlarm((record) => {
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
						Namespace: "MyMemo/AgentCoreDispatch",
						Metrics: [{ Name: "PoisonDispatch", Unit: "Count" }],
					},
				],
			},
		});
		expect(records[0]).not.toContain("prompt");
	});

	it("reports disabled retries separately from poison dispatches", async () => {
		const records: string[] = [];
		const alarm = createEmbeddedMetricAgentCoreDispatchAlarm((record) => {
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
						Namespace: "MyMemo/AgentCoreDispatch",
						Metrics: [{ Name: "DisabledDelivery", Unit: "Count" }],
					},
				],
			},
		});
		expect(records[0]).not.toContain("PoisonDispatch");
	});
});
