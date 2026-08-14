import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import {
	type CanaryFixtureConfig,
	type CanaryFixtureDb,
	createCanaryFixtureVerifier,
} from "./fixture";

let client: PGlite;
let db: CanaryFixtureDb;

const configuredDocument = {
	documentId: "fixture-doc-v3",
	version: 3,
	contentSha256:
		"cab47e977f6a92635793dc70f27931ccea0f22bcc5e482b02571ade91a6b9a07",
} as const;

const configuredFixture: CanaryFixtureConfig = {
	version: "fixture-v1",
	checksum: "c2c994e77fdca1bce1800f9055292d87a282937ff17240de1f0cc3c6bd7ab014",
	identity: { kind: "non_human", userId: "agentcore-canary-service" },
	collectionId: "agentcore-canary-fixture",
	documents: [configuredDocument],
};

beforeAll(async () => {
	client = new PGlite();
	await client.waitReady;
	db = {
		query: async <T>(text: string, params: unknown[] = []) =>
			(await client.query<T>(text, params)).rows,
	};
	await client.exec(`
		CREATE TABLE source_asset (
			id text PRIMARY KEY,
			workspace_id text NOT NULL,
			status text NOT NULL
		);
		CREATE TABLE document (
			id text PRIMARY KEY,
			source_asset_id text NOT NULL,
			workspace_id text NOT NULL,
			version integer NOT NULL,
			canonical_markdown text NOT NULL,
			status text NOT NULL
		);
		CREATE TABLE passage (
			id text PRIMARY KEY,
			document_id text NOT NULL,
			workspace_id text NOT NULL,
			status text NOT NULL
		);
		CREATE TABLE content_collection (
			compat_int_id bigint PRIMARY KEY,
			compat_str_id text NOT NULL,
			member_code text NOT NULL
		);
		CREATE TABLE passage_collection (
			passage_id text NOT NULL,
			collection_id text NOT NULL
		);

		INSERT INTO source_asset VALUES
			('fixture-asset', 'agentcore-canary-service', 'ready'),
			('real-asset', 'real-member', 'ready');
		INSERT INTO document VALUES
			('fixture-doc-v2', 'fixture-asset', 'agentcore-canary-service', 2, 'old fixture body', 'active'),
			('fixture-doc-v3', 'fixture-asset', 'agentcore-canary-service', 3, 'synthetic fixture body v3', 'active'),
			('real-doc-v1', 'real-asset', 'real-member', 1, 'real user content', 'active');
		INSERT INTO passage VALUES
			('fixture-old-passage', 'fixture-doc-v2', 'agentcore-canary-service', 'active'),
			('fixture-current-passage', 'fixture-doc-v3', 'agentcore-canary-service', 'active'),
			('real-passage', 'real-doc-v1', 'real-member', 'active');
		INSERT INTO content_collection VALUES
			(449, 'agentcore-canary-fixture', 'agentcore-canary-service'),
			(450, 'real-collection', 'real-member');
		INSERT INTO passage_collection VALUES
			('fixture-old-passage', '449'),
			('fixture-current-passage', '449'),
			('real-passage', '450');
	`);
});

afterAll(async () => {
	await client.close();
});

describe("the configured Canary fixture verifier", () => {
	it("verifies the non-human identity, collection, current document versions, content, and checksum", async () => {
		const verifier = createCanaryFixtureVerifier(db);

		await expect(verifier.verify(configuredFixture)).resolves.toBeUndefined();
	});

	it("refuses identity, collection, inventory, version, content, and checksum drift", async () => {
		const verifier = createCanaryFixtureVerifier(db);
		const cases: CanaryFixtureConfig[] = [
			{
				...configuredFixture,
				identity: { kind: "non_human", userId: "real-member" },
			},
			{ ...configuredFixture, collectionId: "real-collection" },
			{ ...configuredFixture, documents: [] },
			{
				...configuredFixture,
				documents: [{ ...configuredDocument, version: 2 }],
			},
			{
				...configuredFixture,
				documents: [
					{
						...configuredDocument,
						contentSha256: "0".repeat(64),
					},
				],
			},
			{ ...configuredFixture, checksum: "0".repeat(64) },
		];

		for (const drifted of cases) {
			await expect(verifier.verify(drifted)).rejects.toThrow("Canary fixture");
		}
	});
});
