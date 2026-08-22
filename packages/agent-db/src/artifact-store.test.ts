import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	ArtifactQuotaError,
	MAX_ARTIFACT_SIZE_BYTES,
	publishArtifactsAndTransitionRunDoneTx,
	recordArtifactObjectsTx,
} from "./artifact-store";
import {
	claimConversationTx,
	releaseConversationTx,
} from "./conversation-ownership";
import {
	type RunWriteOwner,
	startClaimedRunTx,
	type TerminalTransitionResult,
} from "./run-store";
import {
	artifactObjects,
	conversationArtifacts,
	conversationRuntime,
	conversations,
	runEvents,
	runs,
} from "./schema";
import { createTestDatabase, seedQueuedRun, type TestDb } from "./testing";

let tdb: TestDb;

beforeAll(async () => {
	tdb = await createTestDatabase(undefined, { legacyFargate: true });
});

afterAll(async () => {
	await tdb.close();
});

afterEach(async () => {
	await tdb.db.delete(artifactObjects);
	await tdb.db.delete(runs);
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
});

async function claimRun(
	runId: string,
	workerId = "worker-1",
): Promise<RunWriteOwner> {
	const claim = await claimConversationTx(tdb.db, { workerId });
	if (!claim) throw new Error("test setup claimed no Conversation");
	const started = await startClaimedRunTx(tdb.db, {
		owner: claim,
		runId,
		workerId,
	});
	if (started.outcome !== "started") {
		throw new Error(`test setup could not start ${runId}`);
	}
	return { ...claim, runId, workerId };
}

describe("Downloadable artifact publication", () => {
	it("publishes the session pointer, staged metadata, and run_done together", async () => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		const owner = await claimRun("run-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		await recordArtifactObjectsTx(tdb.db, {
			objects: [
				{
					objectKey: "objects/opaque-1",
					userId: "user-1",
					conversationId: "conv-1",
					runId: "run-1",
					path: "report.txt",
				},
			],
		});

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);

		await publishArtifactsAndTransitionRunDoneTx(tdb.db, {
			owner,
			artifacts: [
				{
					artifactId: "artifact-1",
					path: "report.txt",
					objectKey: "objects/opaque-1",
					sizeBytes: 12,
					contentType: "application/octet-stream",
				},
			],
			agentSessionId: "session-1",
		});

		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([
			expect.objectContaining({
				artifactId: "artifact-1",
				path: "report.txt",
				objectKey: "objects/opaque-1",
				sizeBytes: 12,
			}),
		]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([
			expect.objectContaining({
				objectKey: "objects/opaque-1",
				status: "current",
			}),
		]);
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("done");
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("session-1");
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_done"]);
	});

	it("replaces a current path without changing its artifact id or creation time", async () => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		for (const [runId, objectKey, artifactId] of [
			["run-1", "objects/one", "artifact-stable"],
			["run-2", "objects/two", "artifact-ignored"],
		] as const) {
			await seedQueuedRun(tdb.db, {
				runId,
				userId: "user-1",
				conversationId: "conv-1",
			});
			const owner = await claimRun(runId);
			await recordArtifactObjectsTx(tdb.db, {
				objects: [
					{
						objectKey,
						userId: "user-1",
						conversationId: "conv-1",
						runId,
						path: "report.txt",
					},
				],
			});
			await publishArtifactsAndTransitionRunDoneTx(tdb.db, {
				owner,
				artifacts: [
					{
						artifactId,
						path: "report.txt",
						objectKey,
						sizeBytes: runId === "run-1" ? 3 : 7,
						contentType: "application/octet-stream",
					},
				],
			});
			await releaseConversationTx(tdb.db, owner);
		}

		const [current] = await tdb.db.select().from(conversationArtifacts);
		expect(current).toMatchObject({
			artifactId: "artifact-stable",
			objectKey: "objects/two",
			sizeBytes: 7,
		});
		const ledger = await tdb.db
			.select()
			.from(artifactObjects)
			.orderBy(artifactObjects.objectKey);
		expect(
			ledger.map(({ objectKey, status }) => ({ objectKey, status })),
		).toEqual([
			{ objectKey: "objects/one", status: "superseded" },
			{ objectKey: "objects/two", status: "current" },
		]);
	});

	it("rolls back session continuity when artifact persistence fails", async () => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			agentSessionId: "session-old",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		const owner = await claimRun("run-1");

		await expect(
			publishArtifactsAndTransitionRunDoneTx(tdb.db, {
				owner,
				agentSessionId: "session-new",
				artifacts: [
					{
						artifactId: "artifact-1",
						path: "report.txt",
						objectKey: "objects/not-ledgered",
						sizeBytes: 1,
						contentType: "application/octet-stream",
					},
				],
			}),
		).rejects.toThrow(/ledger/);

		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("session-old");
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("running");
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
	});

	it("publishes artifacts and Outcome without a pointer when the runtime row is absent", async () => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		const owner = await claimRun("run-1");
		await recordArtifactObjectsTx(tdb.db, {
			objects: [
				{
					objectKey: "objects/opaque-1",
					userId: "user-1",
					conversationId: "conv-1",
					runId: "run-1",
					path: "report.txt",
				},
			],
		});

		const result = await publishArtifactsAndTransitionRunDoneTx(tdb.db, {
			owner,
			agentSessionId: "session-without-runtime",
			artifacts: [
				{
					artifactId: "artifact-1",
					path: "report.txt",
					objectKey: "objects/opaque-1",
					sizeBytes: 12,
					contentType: "application/octet-stream",
				},
			],
		});

		expect(result).toMatchObject({
			outcome: "committed",
			run: { status: "done" },
		});
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("done");
		expect(await tdb.db.select().from(conversationArtifacts)).toHaveLength(1);
		expect(
			(await tdb.db.select().from(runEvents)).map((event) => event.type),
		).toEqual(["run_done"]);
		expect(await tdb.db.select().from(artifactObjects)).toEqual([
			expect.objectContaining({ status: "current" }),
		]);
	});

	it("leaves the first session pointer empty when artifact validation rejects publication", async () => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		const owner = await claimRun("run-1");

		await expect(
			publishArtifactsAndTransitionRunDoneTx(tdb.db, {
				owner,
				agentSessionId: "session-new",
				artifacts: [
					{
						artifactId: "artifact-1",
						path: "oversized.bin",
						objectKey: "objects/oversized",
						sizeBytes: MAX_ARTIFACT_SIZE_BYTES + 1,
						contentType: "application/octet-stream",
					},
				],
			}),
		).rejects.toBeInstanceOf(ArtifactQuotaError);

		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBeNull();
		expect((await tdb.db.select().from(runs))[0]?.status).toBe("running");
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
	});

	it.each([
		[
			"an interruption was requested",
			"run",
			{ status: "interrupt_requested" },
			{
				outcome: "rejected",
				rejected: "status",
				current: "interrupt_requested",
			} satisfies TerminalTransitionResult,
		],
		[
			"ownership expired",
			"conversation",
			{ ownerUntil: new Date(Date.now() - 1_000) },
			{
				outcome: "rejected",
				rejected: "lease",
			} satisfies TerminalTransitionResult,
		],
	])("takes the Run fence before any metadata write, so publication is a no-op once %s", async (_case, target, mutation, expected) => {
		await tdb.db.insert(conversations).values({
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "fargate",
		});
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		await seedQueuedRun(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		const owner = await claimRun("run-1");
		await recordArtifactObjectsTx(tdb.db, {
			objects: [
				{
					objectKey: "objects/opaque-1",
					userId: "user-1",
					conversationId: "conv-1",
					runId: "run-1",
					path: "report.txt",
				},
			],
		});
		if (target === "run" && "status" in mutation) {
			await tdb.db.update(runs).set({ status: mutation.status });
		} else {
			if (!("ownerUntil" in mutation)) throw new Error("invalid test case");
			await tdb.db
				.update(conversations)
				.set({ ownerUntil: mutation.ownerUntil });
		}

		const result = await publishArtifactsAndTransitionRunDoneTx(tdb.db, {
			owner,
			agentSessionId: "session-new",
			artifacts: [
				{
					artifactId: "artifact-1",
					path: "report.txt",
					objectKey: "objects/opaque-1",
					sizeBytes: 12,
					contentType: "application/octet-stream",
				},
			],
		});

		expect(result).toEqual(expected);
		expect(await tdb.db.select().from(conversationArtifacts)).toEqual([]);
		expect(await tdb.db.select().from(runEvents)).toEqual([]);
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBeNull();
		// The staged object stays `pending`, so cleanup still owns it.
		expect((await tdb.db.select().from(artifactObjects))[0]?.status).toBe(
			"pending",
		);
	});
});
