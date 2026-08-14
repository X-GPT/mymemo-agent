import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	assertAgentCoreCanaryCreationReady,
	assertFargateRollbackAllowed,
	markFargateLaneAwareDeploymentReady,
} from "./execution-lane-deployment";
import { conversations, executionLaneDeployments } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversations);
	await tdb.db.delete(executionLaneDeployments);
});

describe("AgentCore-canary creation deployment assertion", () => {
	it("fails closed until the converged Fargate rollout records readiness", async () => {
		await expect(
			tdb.db.transaction(assertAgentCoreCanaryCreationReady),
		).rejects.toThrow("Fargate deployment is not fully execution-lane-aware");

		await markFargateLaneAwareDeploymentReady(tdb.db);

		await expect(
			tdb.db.transaction(assertAgentCoreCanaryCreationReady),
		).resolves.toBeUndefined();
	});
});

describe("Fargate rollback assertion", () => {
	it("permits a lane-unaware rollback only when no AgentCore-canary Conversation remains", async () => {
		await markFargateLaneAwareDeploymentReady(tdb.db);
		await expect(
			assertFargateRollbackAllowed(tdb.db, { candidateLaneAware: false }),
		).resolves.toBeUndefined();
		await expect(
			tdb.db.transaction(assertAgentCoreCanaryCreationReady),
		).rejects.toThrow("Fargate deployment is not fully execution-lane-aware");

		await markFargateLaneAwareDeploymentReady(tdb.db);
		await tdb.db.insert(conversations).values({
			userId: "synthetic-user",
			conversationId: "canary-conversation",
			scope: "collection",
			executionLane: "agentcore_canary",
		});

		await expect(
			assertFargateRollbackAllowed(tdb.db, { candidateLaneAware: false }),
		).rejects.toThrow(
			"lane-unaware Fargate rollback refused while AgentCore-canary Conversations exist",
		);
		await expect(
			assertFargateRollbackAllowed(tdb.db, { candidateLaneAware: true }),
		).resolves.toBeUndefined();
		await expect(
			tdb.db.transaction(assertAgentCoreCanaryCreationReady),
		).resolves.toBeUndefined();
	});
});
