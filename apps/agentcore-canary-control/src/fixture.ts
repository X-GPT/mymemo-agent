export interface CanaryFixtureDocument {
	documentId: string;
	version: number;
	contentSha256: string;
}

/** Entirely deployment-owned; none of these fields come from an operator. */
export interface CanaryFixtureConfig {
	version: string;
	checksum: string;
	identity: { kind: "non_human"; userId: string };
	collectionId: string;
	documents: CanaryFixtureDocument[];
}

export interface CanaryFixtureVerifier {
	verify(configured: CanaryFixtureConfig): Promise<void>;
}

export interface CanaryFixtureDb {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
}

export class CanaryFixtureVerificationError extends Error {
	override name = "CanaryFixtureVerificationError" as const;
}

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortedDocuments(
	documents: readonly CanaryFixtureDocument[],
): CanaryFixtureDocument[] {
	return [...documents].sort((a, b) =>
		a.documentId.localeCompare(b.documentId),
	);
}

export function computeCanaryFixtureChecksum(
	fixture: Omit<CanaryFixtureConfig, "checksum">,
): string {
	return sha256(
		JSON.stringify({
			version: fixture.version,
			identity: fixture.identity,
			collectionId: fixture.collectionId,
			documents: sortedDocuments(fixture.documents),
		}),
	);
}

function fail(reason: string): never {
	throw new CanaryFixtureVerificationError(`Canary fixture ${reason}`);
}

function validateConfiguredFixture(configured: CanaryFixtureConfig): void {
	if (
		configured.identity.kind !== "non_human" ||
		configured.identity.userId.trim() === "" ||
		configured.collectionId.trim() === "" ||
		configured.version.trim() === ""
	) {
		fail("identity, collection, and version must be configured as non-human");
	}
	if (!/^[a-f0-9]{64}$/.test(configured.checksum)) {
		fail("checksum must be a lowercase SHA-256 value");
	}
	const seen = new Set<string>();
	for (const document of configured.documents) {
		if (
			document.documentId.trim() === "" ||
			!Number.isSafeInteger(document.version) ||
			document.version < 1 ||
			!/^[a-f0-9]{64}$/.test(document.contentSha256) ||
			seen.has(document.documentId)
		) {
			fail("document inventory is invalid");
		}
		seen.add(document.documentId);
	}
	const expectedChecksum = computeCanaryFixtureChecksum({
		version: configured.version,
		identity: configured.identity,
		collectionId: configured.collectionId,
		documents: configured.documents,
	});
	if (expectedChecksum !== configured.checksum) {
		fail("checksum does not match its configured inventory");
	}
}

interface FixtureDocumentRow {
	documentId: string;
	version: number;
	content: string;
}

/**
 * Verify the pre-provisioned synthetic collection against the current indexed
 * document versions. Both collection ownership and document workspace are
 * pinned to the configured non-human identity, so a real user's collection or
 * document cannot satisfy the fixture check.
 */
export function createCanaryFixtureVerifier(
	db: CanaryFixtureDb,
): CanaryFixtureVerifier {
	return {
		async verify(configured) {
			validateConfiguredFixture(configured);
			const rows = await db.query<FixtureDocumentRow>(
				`WITH current_documents AS (
					SELECT DISTINCT ON (d.source_asset_id)
					       d.id AS "documentId",
					       d.version,
					       d.canonical_markdown AS content
					  FROM document d
					  JOIN source_asset sa ON sa.id = d.source_asset_id
					 WHERE d.workspace_id = $1
					   AND d.status = 'active'
					   AND sa.workspace_id = $1
					   AND sa.status = 'ready'
					 ORDER BY d.source_asset_id, d.version DESC, d.id DESC
				)
				SELECT DISTINCT cd."documentId", cd.version, cd.content
				  FROM content_collection c
				  JOIN passage_collection pc
				    ON pc.collection_id = c.compat_int_id::text
				  JOIN passage p ON p.id = pc.passage_id
				  JOIN current_documents cd ON cd."documentId" = p.document_id
				 WHERE c.compat_str_id = $2
				   AND c.member_code = $1
				   AND p.workspace_id = $1
				   AND p.status = 'active'
				 ORDER BY cd."documentId"`,
				[configured.identity.userId, configured.collectionId],
			);
			const observedDocuments = rows.map((row) => ({
				documentId: row.documentId,
				version: Number(row.version),
				contentSha256: sha256(row.content),
			}));
			const observedChecksum = computeCanaryFixtureChecksum({
				version: configured.version,
				identity: configured.identity,
				collectionId: configured.collectionId,
				documents: observedDocuments,
			});
			if (observedChecksum !== configured.checksum) {
				fail(
					"identity, collection, inventory, version, content, or checksum drifted",
				);
			}
		},
	};
}

/** Production read-only KB adapter used by the operator control Lambda. */
export function createCanaryFixtureDb(kbDatabaseUrl: string): CanaryFixtureDb {
	if (kbDatabaseUrl.trim() === "") {
		throw new Error(
			"KB_DATABASE_URL is required for Canary fixture verification",
		);
	}
	const pool = new Pool({
		connectionString: kbDatabaseUrl,
		max: 2,
		statement_timeout: 5_000,
		query_timeout: 10_000,
	});
	return {
		query: async <T>(text: string, params: unknown[] = []) =>
			(await pool.query(text, params)).rows as T[],
	};
}

import { createHash } from "node:crypto";
import { Pool } from "pg";
