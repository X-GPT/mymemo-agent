import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import {
	assertAgentCoreCreationReady,
	markFargateRuntimeAwareDeploymentReady,
	prepareFargateDeploymentCompatibility,
} from "./execution-runtime-deployment";
import { conversations, executionRuntimeDeployments } from "./schema";
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
	await tdb.db.delete(executionRuntimeDeployments);
});

describe("AgentCore creation deployment assertion", () => {
	it("fails closed until the converged Fargate rollout records readiness", async () => {
		await expect(
			tdb.db.transaction(assertAgentCoreCreationReady),
		).rejects.toThrow(
			"Fargate deployment is not fully execution-runtime-aware",
		);

		await markFargateRuntimeAwareDeploymentReady(tdb.db);

		await expect(
			tdb.db.transaction(assertAgentCoreCreationReady),
		).resolves.toBeUndefined();
	});
});

describe("Fargate deployment compatibility", () => {
	it("clears readiness for a runtime-unaware candidate only when no AgentCore Conversation exists", async () => {
		await markFargateRuntimeAwareDeploymentReady(tdb.db);
		await expect(
			prepareFargateDeploymentCompatibility(tdb.db, {
				candidateRuntimeAware: false,
			}),
		).resolves.toBeUndefined();
		await expect(
			tdb.db.transaction(assertAgentCoreCreationReady),
		).rejects.toThrow(
			"Fargate deployment is not fully execution-runtime-aware",
		);

		await markFargateRuntimeAwareDeploymentReady(tdb.db);
		await tdb.db.insert(conversations).values({
			userId: "synthetic-user",
			conversationId: "agentcore-conversation",
			scope: "collection",
			executionRuntime: "agentcore",
		});

		await expect(
			prepareFargateDeploymentCompatibility(tdb.db, {
				candidateRuntimeAware: false,
			}),
		).rejects.toThrow(
			"runtime-unaware Fargate deployment is incompatible while AgentCore Conversations exist",
		);
		await expect(
			prepareFargateDeploymentCompatibility(tdb.db, {
				candidateRuntimeAware: true,
			}),
		).resolves.toBeUndefined();
		await expect(
			tdb.db.transaction(assertAgentCoreCreationReady),
		).resolves.toBeUndefined();
	});
});
