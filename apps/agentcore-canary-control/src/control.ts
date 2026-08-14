import { createHash } from "node:crypto";
import {
	findActiveCanaryCampaign,
	findCanaryCampaignByIdempotencyKey,
	requireCanaryCampaignMatchesInput,
	type StartCanaryCampaignInput,
	startCanaryCampaignTx,
} from "@mymemo/agent-db/canary-control";
import type { Database } from "@mymemo/agent-db/client";
import type { CanaryFixtureConfig, CanaryFixtureVerifier } from "./fixture";

export interface CanaryControlConfig {
	campaignVersion: string;
	fixture: CanaryFixtureConfig;
	scenario: {
		id: string;
		prompt: string;
		model: string;
	};
}

export interface CanaryStartRequest {
	idempotencyKey: string;
	campaignVersion: string;
}

export interface CanaryScenarioIdentities {
	campaignId: string;
	conversationId: string;
	runId: string;
	messageId: string;
	dispatchId: string;
}

export function parseCanaryStartRequest(value: unknown): CanaryStartRequest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(
			"Canary start request must contain exactly idempotencyKey and campaignVersion",
		);
	}
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "campaignVersion,idempotencyKey"
	) {
		throw new Error(
			"Canary start request must contain exactly idempotencyKey and campaignVersion",
		);
	}
	if (
		typeof record.idempotencyKey !== "string" ||
		record.idempotencyKey.trim() === "" ||
		record.idempotencyKey.length > 200 ||
		typeof record.campaignVersion !== "string" ||
		record.campaignVersion.trim() === "" ||
		record.campaignVersion.length > 200
	) {
		throw new Error(
			"Canary start request identifiers must be non-empty strings",
		);
	}
	return {
		idempotencyKey: record.idempotencyKey,
		campaignVersion: record.campaignVersion,
	};
}

function deterministicUuid(kind: string, ...parts: string[]): string {
	const bytes = createHash("sha256")
		.update(["mymemo-agentcore-canary-v1", kind, ...parts].join("\0"))
		.digest()
		.subarray(0, 16);
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function deriveCanaryScenarioIdentities(input: {
	idempotencyKey: string;
	campaignVersion: string;
	scenarioId: string;
}): CanaryScenarioIdentities {
	const campaignId = deterministicUuid(
		"campaign",
		input.campaignVersion,
		input.idempotencyKey,
	);
	return {
		campaignId,
		conversationId: deterministicUuid("conversation", campaignId),
		runId: deterministicUuid("run", campaignId, input.scenarioId),
		messageId: deterministicUuid("message", campaignId, input.scenarioId),
		dispatchId: deterministicUuid("dispatch", campaignId, input.scenarioId),
	};
}

function requireConfigured(value: string, name: string): void {
	if (value.trim() === "") throw new Error(`${name} must be configured`);
}

export function createCanaryControl(options: {
	db: Database;
	config: CanaryControlConfig;
	verifier: CanaryFixtureVerifier;
}) {
	const { db, config, verifier } = options;
	requireConfigured(config.campaignVersion, "Campaign version");
	requireConfigured(config.fixture.version, "fixture version");
	requireConfigured(config.fixture.checksum, "fixture checksum");
	requireConfigured(config.fixture.identity.userId, "synthetic identity");
	requireConfigured(config.fixture.collectionId, "fixture collection");
	requireConfigured(config.scenario.id, "scenario id");
	requireConfigured(config.scenario.prompt, "scenario prompt");
	requireConfigured(config.scenario.model, "scenario model");

	return {
		async start(rawRequest: unknown) {
			const request = parseCanaryStartRequest(rawRequest);
			if (request.campaignVersion !== config.campaignVersion) {
				throw new Error(
					"requested Campaign version is not the deployed version",
				);
			}
			const identities = deriveCanaryScenarioIdentities({
				...request,
				scenarioId: config.scenario.id,
			});
			const campaignInput: StartCanaryCampaignInput = {
				...identities,
				idempotencyKey: request.idempotencyKey,
				campaignVersion: config.campaignVersion,
				fixtureVersion: config.fixture.version,
				fixtureChecksum: config.fixture.checksum,
				model: config.scenario.model,
				scenarioId: config.scenario.id,
				userId: config.fixture.identity.userId,
				collectionId: config.fixture.collectionId,
				prompt: config.scenario.prompt,
			};
			const existing = await findCanaryCampaignByIdempotencyKey(
				db,
				request.idempotencyKey,
			);
			// This read-only fast path avoids re-verifying the KB fixture for an exact
			// retry. startCanaryCampaignTx repeats the checks under its transaction;
			// only that path is authoritative when concurrent starts race.
			if (existing) {
				requireCanaryCampaignMatchesInput(existing, campaignInput);
				return { outcome: "existing" as const, campaign: existing, identities };
			}
			const active = await findActiveCanaryCampaign(db);
			if (active) {
				return {
					outcome: "active_campaign" as const,
					campaign: active,
					identities,
				};
			}

			await verifier.verify(config.fixture);
			const result = await startCanaryCampaignTx(db, campaignInput);
			return { ...result, identities };
		},
	};
}
