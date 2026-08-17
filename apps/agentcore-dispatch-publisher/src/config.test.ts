import { describe, expect, it } from "bun:test";
import { loadAgentCoreDispatchPublisherConfigFromEnv } from "./config";

function baseEnv(): Record<string, string | undefined> {
	return {
		AGENT_DATABASE_URL: "postgresql://publisher@localhost:5432/mymemo_agent",
		DB_PASSWORD: "secret",
		DB_SSL: "disable",
		AWS_REGION: "us-west-2",
		CANARY_DISPATCH_QUEUE_URL:
			"https://sqs.us-west-2.amazonaws.com/123456789012/agentcore-dispatch",
		CANARY_ENABLED_PARAMETER_NAME: "/mymemo/agentcore-dispatch/enabled",
		LOG_LEVEL: "info",
	};
}

describe("loadAgentCoreDispatchPublisherConfigFromEnv", () => {
	it("loads only publisher authority", () => {
		expect(loadAgentCoreDispatchPublisherConfigFromEnv(baseEnv())).toEqual({
			agentDatabaseUrl:
				"postgresql://publisher:secret@localhost:5432/mymemo_agent",
			awsRegion: "us-west-2",
			queueUrl:
				"https://sqs.us-west-2.amazonaws.com/123456789012/agentcore-dispatch",
			enabledParameterName: "/mymemo/agentcore-dispatch/enabled",
			intervalMs: 2_000,
			logLevel: "info",
		});
	});

	it("does not require Run-serving authority", () => {
		expect(() =>
			loadAgentCoreDispatchPublisherConfigFromEnv(baseEnv()),
		).not.toThrow();
	});

	it("honors the dedicated tick interval", () => {
		const env = baseEnv();
		env.AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS = "1500";
		expect(loadAgentCoreDispatchPublisherConfigFromEnv(env).intervalMs).toBe(
			1_500,
		);
	});

	it("rejects a non-positive tick interval", () => {
		const env = baseEnv();
		env.AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS = "0";
		expect(() => loadAgentCoreDispatchPublisherConfigFromEnv(env)).toThrow(
			/AGENTCORE_DISPATCH_PUBLISHER_INTERVAL_MS/,
		);
	});

	for (const [key, value] of [
		["AGENT_DATABASE_URL", "not-a-database-url"],
		["AGENT_DATABASE_URL", "https://publisher@example.com/mymemo_agent"],
		["AWS_REGION", "us west 2"],
		["AWS_REGION", " us-west-2"],
		["CANARY_DISPATCH_QUEUE_URL", "https://example.com/123456789012/dispatch"],
		[
			"CANARY_DISPATCH_QUEUE_URL",
			"https://sqs.us-east-1.amazonaws.com/123456789012/dispatch",
		],
		[
			"CANARY_DISPATCH_QUEUE_URL",
			"https://sqs.us-west-2.amazonaws.com/not-an-account/dispatch",
		],
		[
			"CANARY_DISPATCH_QUEUE_URL",
			"https://sqs.us-west-2.amazonaws.com/123456789012/dispatch/extra",
		],
		[
			"CANARY_DISPATCH_QUEUE_URL",
			"https://sqs.us-west-2.amazonaws.com/123456789012/dispatch.fifo",
		],
		["CANARY_ENABLED_PARAMETER_NAME", "/mymemo/dispatch enabled"],
		["CANARY_ENABLED_PARAMETER_NAME", " /mymemo/dispatch/enabled"],
	] as const) {
		it(`refuses malformed ${key}: ${value}`, () => {
			const env = baseEnv();
			env[key] = value;
			expect(() => loadAgentCoreDispatchPublisherConfigFromEnv(env)).toThrow(
				new RegExp(key),
			);
		});
	}

	for (const key of [
		"AGENT_DATABASE_URL",
		"AWS_REGION",
		"CANARY_DISPATCH_QUEUE_URL",
		"CANARY_ENABLED_PARAMETER_NAME",
	]) {
		it(`refuses to start without ${key}`, () => {
			const env = baseEnv();
			delete env[key];
			expect(() => loadAgentCoreDispatchPublisherConfigFromEnv(env)).toThrow(
				new RegExp(key),
			);
		});
	}
});
