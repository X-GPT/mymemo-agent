import { describe, expect, it } from "bun:test";
import type { ApiConfig } from "@/config/env";
import { conversationArtifacts } from "@/db/schema";
import { createTestDatabase } from "@/db/testing";
import type { AppDeps } from "@/deps";
import { PostgresConversationStore } from "@/features/conversation-store";
import type {
	ArtifactDownloadSigner,
	ArtifactDownloadSignInput,
} from "./artifact-download-signer";
import type {
	ArtifactMetadataStore,
	CurrentArtifact,
} from "./artifact-metadata-store";
import { PostgresArtifactMetadataStore } from "./postgres-artifact-metadata-store";

const { createApp } = await import("@/app");

const identityHeaders = {
	"x-member-code": "member-1",
	"x-partner-code": "partner-1",
};

const ownedConversation = {
	userId: "member-1",
	conversationId: "conversation-1",
	scope: "general" as const,
	collectionId: null,
	summaryId: null,
};

function buildApp(options?: {
	artifacts?: CurrentArtifact[];
	conversationExists?: boolean;
}) {
	const artifacts = options?.artifacts ?? [];
	const artifactLookups: string[] = [];
	const signInputs: ArtifactDownloadSignInput[] = [];
	let listCalls = 0;
	let gateCalls = 0;
	const artifactMetadataStore: ArtifactMetadataStore = {
		async listCurrent() {
			listCalls++;
			return artifacts
				.map(({ objectKey: _, ...metadata }) => metadata)
				.sort((a, b) => a.path.localeCompare(b.path));
		},
		async getCurrent({ artifactId }) {
			artifactLookups.push(artifactId);
			return (
				artifacts.find((artifact) => artifact.artifactId === artifactId) ?? null
			);
		},
	};
	const artifactDownloadSigner: ArtifactDownloadSigner = {
		async createDownloadUrl(input) {
			signInputs.push(input);
			return `https://objects.example/signed-${signInputs.length}`;
		},
	};
	const deps = {
		conversationStore: {
			async get({
				userId,
				conversationId,
			}: {
				userId: string;
				conversationId: string;
			}) {
				return options?.conversationExists === false ||
					userId !== ownedConversation.userId ||
					conversationId !== ownedConversation.conversationId
					? null
					: ownedConversation;
			},
		},
		artifactMetadataStore,
		artifactDownloadSigner,
		exposureGate: {
			async isAgentEnabled() {
				gateCalls++;
				throw new Error("artifact reads must not consult the exposure gate");
			},
		},
	} as unknown as AppDeps;
	return {
		app: createApp({ logLevel: "silent" } as ApiConfig, deps),
		artifactLookups,
		signInputs,
		get listCalls() {
			return listCalls;
		},
		get gateCalls() {
			return gateCalls;
		},
	};
}

function artifact(overrides: Partial<CurrentArtifact>): CurrentArtifact {
	return {
		artifactId: "artifact-1",
		path: "report.pdf",
		objectKey: "private/current-object",
		sizeBytes: 42,
		contentType: "application/pdf",
		createdAt: new Date("2026-07-15T01:00:00.000Z"),
		updatedAt: new Date("2026-07-15T02:00:00.000Z"),
		...overrides,
	};
}

describe("GET /v1/conversations/:conversationId/artifacts", () => {
	it("returns the complete path-sorted list with exactly public metadata", async () => {
		const first = artifact({
			artifactId: "artifact-z",
			path: "zeta/report.pdf",
			objectKey: "private/secret-z",
		});
		const second = artifact({
			artifactId: "artifact-a",
			path: "alpha/data.csv",
			objectKey: "private/secret-a",
			contentType: "text/csv",
		});
		const harness = buildApp({ artifacts: [first, second] });

		const response = await harness.app.request(
			"/v1/conversations/conversation-1/artifacts",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			artifacts: [
				{
					artifactId: "artifact-a",
					path: "alpha/data.csv",
					sizeBytes: 42,
					contentType: "text/csv",
					createdAt: "2026-07-15T01:00:00.000Z",
					updatedAt: "2026-07-15T02:00:00.000Z",
				},
				{
					artifactId: "artifact-z",
					path: "zeta/report.pdf",
					sizeBytes: 42,
					contentType: "application/pdf",
					createdAt: "2026-07-15T01:00:00.000Z",
					updatedAt: "2026-07-15T02:00:00.000Z",
				},
			],
		});
		expect(harness.signInputs).toHaveLength(0);
		expect(harness.gateCalls).toBe(0);
	});

	it("requires trusted identity and checks conversation ownership before metadata", async () => {
		const missingIdentity = buildApp();
		const missingIdentityResponse = await missingIdentity.app.request(
			"/v1/conversations/conversation-1/artifacts",
		);
		expect(missingIdentityResponse.status).toBe(401);
		expect(missingIdentity.listCalls).toBe(0);

		const foreignConversation = buildApp({ conversationExists: false });
		const foreignResponse = await foreignConversation.app.request(
			"/v1/conversations/conversation-1/artifacts",
			{ headers: identityHeaders },
		);
		expect(foreignResponse.status).toBe(404);
		expect(foreignConversation.listCalls).toBe(0);
		expect(foreignConversation.gateCalls).toBe(0);
	});
});

describe("GET /v1/conversations/:conversationId/artifacts/:artifactId", () => {
	it("returns a fresh five-minute attachment download URL for the current object", async () => {
		const harness = buildApp({
			artifacts: [
				artifact({
					artifactId: "stable-artifact-id",
					path: 'nested/季度 报告".pdf',
				}),
			],
		});

		const first = await harness.app.request(
			"/v1/conversations/conversation-1/artifacts/stable-artifact-id",
			{ headers: identityHeaders },
		);
		const second = await harness.app.request(
			"/v1/conversations/conversation-1/artifacts/stable-artifact-id",
			{ headers: identityHeaders },
		);

		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("private, no-store");
		expect(await first.json()).toEqual({
			downloadUrl: "https://objects.example/signed-1",
		});
		expect(await second.json()).toEqual({
			downloadUrl: "https://objects.example/signed-2",
		});
		expect(harness.signInputs).toEqual([
			{
				objectKey: "private/current-object",
				expiresInSeconds: 300,
				responseContentType: "application/pdf",
				responseContentDisposition:
					"attachment; filename=\"__ ___.pdf\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A_.pdf",
			},
			{
				objectKey: "private/current-object",
				expiresInSeconds: 300,
				responseContentType: "application/pdf",
				responseContentDisposition:
					"attachment; filename=\"__ ___.pdf\"; filename*=UTF-8''%E5%AD%A3%E5%BA%A6%20%E6%8A%A5%E5%91%8A_.pdf",
			},
		]);
		expect(harness.gateCalls).toBe(0);
	});

	it("returns 404 for a missing or foreign conversation before artifact lookup", async () => {
		const harness = buildApp({ conversationExists: false });
		const response = await harness.app.request(
			"/v1/conversations/conversation-1/artifacts/foreign-artifact",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(404);
		expect(harness.artifactLookups).toHaveLength(0);
		expect(harness.signInputs).toHaveLength(0);
	});

	it("returns 404 without signing when the owned conversation has no such artifact", async () => {
		const harness = buildApp();
		const response = await harness.app.request(
			"/v1/conversations/conversation-1/artifacts/missing-artifact",
			{ headers: identityHeaders },
		);

		expect(response.status).toBe(404);
		expect(harness.artifactLookups).toEqual(["missing-artifact"]);
		expect(harness.signInputs).toHaveLength(0);
		expect(harness.gateCalls).toBe(0);
	});
});

describe("seeded current-artifact HTTP path", () => {
	it("lists and signs the current Postgres object through the Hono app", async () => {
		const tdb = await createTestDatabase();
		try {
			const conversationStore = new PostgresConversationStore(tdb.db);
			await conversationStore.create(ownedConversation);
			await tdb.db.insert(conversationArtifacts).values({
				artifactId: "seeded-artifact",
				userId: "member-1",
				conversationId: "conversation-1",
				path: "exports/seeded.pdf",
				objectKey: "private/seeded-object",
				sizeBytes: 2048,
				contentType: "application/pdf",
				createdAt: new Date("2026-07-15T01:00:00.000Z"),
				updatedAt: new Date("2026-07-15T02:00:00.000Z"),
			});
			const signInputs: ArtifactDownloadSignInput[] = [];
			const deps = {
				conversationStore,
				artifactMetadataStore: new PostgresArtifactMetadataStore(tdb.db),
				artifactDownloadSigner: {
					async createDownloadUrl(input: ArtifactDownloadSignInput) {
						signInputs.push(input);
						return "https://objects.example/seeded-download";
					},
				},
				exposureGate: {
					async isAgentEnabled() {
						throw new Error(
							"artifact reads must not consult the exposure gate",
						);
					},
				},
			} as unknown as AppDeps;
			const app = createApp({ logLevel: "silent" } as ApiConfig, deps);

			const list = await app.request(
				"/v1/conversations/conversation-1/artifacts",
				{ headers: identityHeaders },
			);
			expect(await list.json()).toEqual({
				artifacts: [
					{
						artifactId: "seeded-artifact",
						path: "exports/seeded.pdf",
						sizeBytes: 2048,
						contentType: "application/pdf",
						createdAt: "2026-07-15T01:00:00.000Z",
						updatedAt: "2026-07-15T02:00:00.000Z",
					},
				],
			});

			const download = await app.request(
				"/v1/conversations/conversation-1/artifacts/seeded-artifact",
				{ headers: identityHeaders },
			);
			expect(download.status).toBe(200);
			expect(await download.json()).toEqual({
				downloadUrl: "https://objects.example/seeded-download",
			});
			expect(signInputs[0]).toMatchObject({
				objectKey: "private/seeded-object",
				expiresInSeconds: 300,
				responseContentType: "application/pdf",
			});
		} finally {
			await tdb.close();
		}
	});
});
