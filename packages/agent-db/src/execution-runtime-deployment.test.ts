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
	assertFargateRollbackAllowed,
	markFargateRuntimeAwareDeploymentReady,
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

describe("Fargate rollback assertion", () => {
	it("permits a runtime-unaware rollback only when no AgentCore Conversation remains", async () => {
		await markFargateRuntimeAwareDeploymentReady(tdb.db);
		await expect(
			assertFargateRollbackAllowed(tdb.db, { candidateRuntimeAware: false }),
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
			assertFargateRollbackAllowed(tdb.db, { candidateRuntimeAware: false }),
		).rejects.toThrow(
			"runtime-unaware Fargate rollback refused while AgentCore Conversations exist",
		);
		await expect(
			assertFargateRollbackAllowed(tdb.db, { candidateRuntimeAware: true }),
		).resolves.toBeUndefined();
		await expect(
			tdb.db.transaction(assertAgentCoreCreationReady),
		).resolves.toBeUndefined();
	});
});
