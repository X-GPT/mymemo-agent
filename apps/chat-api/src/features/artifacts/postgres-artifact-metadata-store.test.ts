import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversationArtifacts, conversations } from "@/db/schema";
import { createTestDatabase, type TestDb } from "@/db/testing";
import { PostgresArtifactMetadataStore } from "./postgres-artifact-metadata-store";

describe("PostgresArtifactMetadataStore", () => {
	let tdb: TestDb;
	let store: PostgresArtifactMetadataStore;

	beforeAll(async () => {
		tdb = await createTestDatabase();
		store = new PostgresArtifactMetadataStore(tdb.db);
	});

	afterAll(() => tdb.close());

	afterEach(async () => {
		await tdb.db.delete(conversationArtifacts);
		await tdb.db.delete(conversations);
	});

	async function seedConversation(
		userId: string,
		conversationId: string,
	): Promise<void> {
		await tdb.db.insert(conversations).values({
			userId,
			conversationId,
			scope: "general",
			executionRuntime: "agentcore",
			collectionId: null,
			summaryId: null,
		});
	}

	it("lists only public metadata in lexicographic path order", async () => {
		await seedConversation("user-1", "conversation-1");
		await tdb.db.insert(conversationArtifacts).values([
			{
				artifactId: "artifact-z",
				userId: "user-1",
				conversationId: "conversation-1",
				path: "zeta/report.pdf",
				objectKey: "private/run-1/object-z",
				sizeBytes: 42,
				contentType: "application/pdf",
				createdAt: new Date("2026-07-15T01:00:00.000Z"),
				updatedAt: new Date("2026-07-15T02:00:00.000Z"),
			},
			{
				artifactId: "artifact-a",
				userId: "user-1",
				conversationId: "conversation-1",
				path: "alpha/data.csv",
				objectKey: "private/run-1/object-a",
				sizeBytes: 17,
				contentType: "text/csv",
				createdAt: new Date("2026-07-15T03:00:00.000Z"),
				updatedAt: new Date("2026-07-15T04:00:00.000Z"),
			},
		]);

		expect(
			await store.listCurrent({
				userId: "user-1",
				conversationId: "conversation-1",
			}),
		).toEqual([
			{
				artifactId: "artifact-a",
				path: "alpha/data.csv",
				sizeBytes: 17,
				contentType: "text/csv",
				createdAt: new Date("2026-07-15T03:00:00.000Z"),
				updatedAt: new Date("2026-07-15T04:00:00.000Z"),
			},
			{
				artifactId: "artifact-z",
				path: "zeta/report.pdf",
				sizeBytes: 42,
				contentType: "application/pdf",
				createdAt: new Date("2026-07-15T01:00:00.000Z"),
				updatedAt: new Date("2026-07-15T02:00:00.000Z"),
			},
		]);
	});

	it("loads the current object only within its owner and conversation", async () => {
		await seedConversation("user-1", "conversation-1");
		await seedConversation("user-2", "conversation-2");
		await tdb.db.insert(conversationArtifacts).values({
			artifactId: "artifact-1",
			userId: "user-1",
			conversationId: "conversation-1",
			path: "nested/report.pdf",
			objectKey: "private/current-object",
			sizeBytes: 42,
			contentType: "application/pdf",
		});

		await expect(
			store.getCurrent({
				userId: "user-1",
				conversationId: "conversation-1",
				artifactId: "artifact-1",
			}),
		).resolves.toMatchObject({
			artifactId: "artifact-1",
			path: "nested/report.pdf",
			objectKey: "private/current-object",
			contentType: "application/pdf",
		});
		await expect(
			store.getCurrent({
				userId: "user-2",
				conversationId: "conversation-2",
				artifactId: "artifact-1",
			}),
		).resolves.toBeNull();
	});

	it("enforces one current artifact per owner, conversation, and path while permitting stable-id replacement", async () => {
		await seedConversation("user-1", "conversation-1");
		await tdb.db.insert(conversationArtifacts).values({
			artifactId: "stable-artifact-id",
			userId: "user-1",
			conversationId: "conversation-1",
			path: "report.pdf",
			objectKey: "private/first-object",
			sizeBytes: 10,
			contentType: "application/pdf",
		});

		await expect(
			tdb.db
				.insert(conversationArtifacts)
				.values({
					artifactId: "replacement-id",
					userId: "user-1",
					conversationId: "conversation-1",
					path: "report.pdf",
					objectKey: "private/conflicting-object",
					sizeBytes: 11,
					contentType: "application/pdf",
				})
				.execute(),
		).rejects.toThrow();

		const replacementTime = new Date("2026-07-15T05:00:00.000Z");
		await tdb.db
			.update(conversationArtifacts)
			.set({
				objectKey: "private/replacement-object",
				sizeBytes: 12,
				updatedAt: replacementTime,
			})
			.where(
				and(
					eq(conversationArtifacts.userId, "user-1"),
					eq(conversationArtifacts.conversationId, "conversation-1"),
					eq(conversationArtifacts.path, "report.pdf"),
				),
			);

		await expect(
			store.getCurrent({
				userId: "user-1",
				conversationId: "conversation-1",
				artifactId: "stable-artifact-id",
			}),
		).resolves.toMatchObject({
			artifactId: "stable-artifact-id",
			objectKey: "private/replacement-object",
			sizeBytes: 12,
			updatedAt: replacementTime,
		});
	});
});
