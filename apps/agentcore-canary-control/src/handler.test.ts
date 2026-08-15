import { describe, expect, it } from "bun:test";
import {
	createCanaryControlHandler,
	loadCanaryControlHandlerConfigFromEnv,
	resolveCanaryControlHandlerConfigFromSecretArns,
} from "./handler";

const request = {
	idempotencyKey: "operator-approved-449",
	campaignVersion: "2026-08-14.1",
};

describe("the operator-only Canary Lambda entrypoint", () => {
	it("accepts only the two-field request and invokes the control", async () => {
		const observed: unknown[] = [];
		const handler = createCanaryControlHandler({
			start: async (input: unknown) => {
				observed.push(input);
				return { outcome: "created" as const };
			},
		});

		await expect(handler(request)).resolves.toEqual({ outcome: "created" });
		expect(observed).toEqual([request]);
		await expect(
			handler({ ...request, prompt: "operator prompt" }),
		).rejects.toThrow("exactly idempotencyKey and campaignVersion");
	});

	it("loads fixture and identity authority only from deployment environment", () => {
		const control = {
			campaignVersion: "2026-08-14.1",
			fixture: {
				version: "fixture-v1",
				checksum: "0".repeat(64),
				identity: { kind: "non_human" as const, userId: "canary-service" },
				collectionId: "canary-collection",
				documents: [],
			},
			scenario: {
				id: "baseline-v1",
				prompt: "deployment prompt",
				model: "deployment-model",
			},
		};
		expect(
			loadCanaryControlHandlerConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				KB_DATABASE_URL: "postgres://kb",
				CANARY_APPROVED_SYNTHETIC_USER_ID: "canary-service",
				CANARY_CONTROL_CONFIG_JSON: JSON.stringify(control),
			}),
		).toEqual({
			agentDatabaseUrl: "postgres://agent",
			kbDatabaseUrl: "postgres://kb",
			approvedSyntheticUserId: "canary-service",
			control,
		});
		expect(() =>
			loadCanaryControlHandlerConfigFromEnv({
				AGENT_DATABASE_URL: "postgres://agent",
				KB_DATABASE_URL: "postgres://kb",
				CANARY_CONTROL_CONFIG_JSON: JSON.stringify(control),
			}),
		).toThrow("CANARY_APPROVED_SYNTHETIC_USER_ID is required");
	});

	it("rejects malformed deployment configuration with a named config error", () => {
		const baseEnv = {
			AGENT_DATABASE_URL: "postgres://agent",
			KB_DATABASE_URL: "postgres://kb",
			CANARY_APPROVED_SYNTHETIC_USER_ID: "canary-service",
		};

		for (const malformed of [
			{},
			{ campaignVersion: "v1", fixture: {}, scenario: {} },
			{
				campaignVersion: "v1",
				fixture: {
					version: "fixture-v1",
					checksum: "0".repeat(64),
					identity: { kind: "human", userId: "real-user" },
					collectionId: "collection",
					documents: [],
				},
				scenario: { id: "scenario", prompt: "prompt", model: "model" },
			},
		]) {
			expect(() =>
				loadCanaryControlHandlerConfigFromEnv({
					...baseEnv,
					CANARY_CONTROL_CONFIG_JSON: JSON.stringify(malformed),
				}),
			).toThrow("CANARY_CONTROL_CONFIG_JSON is invalid");
		}
	});

	it("resolves both verified database URLs from exact current secret ARNs", async () => {
		const control = {
			campaignVersion: "2026-08-14.1",
			fixture: {
				version: "fixture-v1",
				checksum: "0".repeat(64),
				identity: { kind: "non_human" as const, userId: "canary-service" },
				collectionId: "canary-collection",
				documents: [],
			},
			scenario: {
				id: "baseline-v1",
				prompt: "deployment prompt",
				model: "deployment-model",
			},
		};
		const agentArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:agent-db-AbCdEf";
		const kbArn =
			"arn:aws:secretsmanager:us-west-2:123456789012:secret:kb-db-AbCdEf";
		const reads: string[] = [];

		const config = await resolveCanaryControlHandlerConfigFromSecretArns(
			{
				CANARY_AGENT_DATABASE_URL_SECRET_ARN: agentArn,
				CANARY_KB_DATABASE_URL_SECRET_ARN: kbArn,
				CANARY_APPROVED_SYNTHETIC_USER_ID: "canary-service",
				CANARY_CONTROL_CONFIG_JSON: JSON.stringify(control),
			},
			async (arn) => {
				reads.push(arn);
				return `postgresql://${arn === agentArn ? "agent" : "kb"}.example/db?sslmode=verify-full`;
			},
		);

		expect(reads).toEqual([agentArn, kbArn]);
		expect(config.agentDatabaseUrl).toContain("agent.example");
		expect(config.kbDatabaseUrl).toContain("kb.example");
	});
});
