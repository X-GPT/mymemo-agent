import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { type RunRecord, transitionRunTerminalInTx } from "./run-store";
import {
	advanceAgentSessionPointerInTx,
	type RunOwnershipRef,
} from "./runtime-store";
import { artifactObjects, conversationArtifacts } from "./schema";

export const MAX_CURRENT_ARTIFACT_PATHS = 100;
export const MAX_ARTIFACT_SIZE_BYTES = 100 * 1_024 * 1_024;
export const MAX_CONVERSATION_ARTIFACT_BYTES = 1_024 * 1_024 * 1_024;

export type ArtifactQuota =
	| "artifact_size_bytes"
	| "conversation_path_count"
	| "conversation_size_bytes";

/** Bounded quota detail safe for structured worker logs. */
export class ArtifactQuotaError extends Error {
	override readonly name = "ArtifactQuotaError";

	constructor(
		readonly quota: ArtifactQuota,
		readonly actual: number,
		readonly limit: number,
	) {
		super(`artifact quota exceeded: ${quota}`);
	}
}

export interface StagedArtifactObject {
	objectKey: string;
	userId: string;
	conversationId: string;
	runId: string;
	path: string;
}

export interface PublishedArtifact {
	artifactId: string;
	path: string;
	objectKey: string;
	sizeBytes: number;
	contentType: string;
}

/** Record every intended object before any upload can create it. */
export async function recordArtifactObjectsTx(
	db: Database,
	input: { objects: StagedArtifactObject[] },
): Promise<void> {
	if (input.objects.length === 0) return;
	await db.insert(artifactObjects).values(input.objects);
}

/**
 * Make every staged object current and terminalize its owned Run as `done` in
 * one fenced transaction. A rejection or persistence error rolls back both the
 * metadata swap and `run_done`, leaving the prior current set intact.
 */
export async function publishArtifactsAndTransitionRunDoneTx(
	db: Database,
	input: {
		owner: RunOwnershipRef;
		artifacts: PublishedArtifact[];
		agentSessionId?: string;
	},
): Promise<{
	run: RunRecord;
	agentSessionPointerAdvanced: boolean | null;
}> {
	if (input.artifacts.length === 0) {
		throw new Error("artifact publication requires at least one staged object");
	}
	validatePublishedArtifacts(input.artifacts);
	return await db.transaction(async (tx) => {
		const currentArtifacts = await tx
			.select({
				path: conversationArtifacts.path,
				objectKey: conversationArtifacts.objectKey,
				sizeBytes: conversationArtifacts.sizeBytes,
			})
			.from(conversationArtifacts)
			.where(
				and(
					eq(conversationArtifacts.userId, input.owner.userId),
					eq(conversationArtifacts.conversationId, input.owner.conversationId),
				),
			)
			.for("update");
		validatePostUpsertQuota(currentArtifacts, input.artifacts);

		let agentSessionPointerAdvanced: boolean | null = null;
		const agentSessionId = input.agentSessionId;
		if (agentSessionId !== undefined) {
			try {
				await tx.transaction(async (savepoint) => {
					await advanceAgentSessionPointerInTx(savepoint, {
						...input.owner,
						agentSessionId,
					});
				});
				agentSessionPointerAdvanced = true;
			} catch {
				agentSessionPointerAdvanced = false;
			}
		}
		const paths = input.artifacts.map((artifact) => artifact.path);
		const changedPaths = new Set(paths);
		const existing = currentArtifacts.filter((artifact) =>
			changedPaths.has(artifact.path),
		);

		const objectKeys = input.artifacts.map((artifact) => artifact.objectKey);
		const promoted = await tx
			.update(artifactObjects)
			.set({ status: "current", committedAt: sql`now()` })
			.where(
				and(
					inArray(artifactObjects.objectKey, objectKeys),
					eq(artifactObjects.userId, input.owner.userId),
					eq(artifactObjects.conversationId, input.owner.conversationId),
					eq(artifactObjects.runId, input.owner.runId),
					eq(artifactObjects.status, "pending"),
				),
			)
			.returning({ objectKey: artifactObjects.objectKey });
		if (promoted.length !== input.artifacts.length) {
			throw new Error(
				"artifact publication ledger did not match the staged set",
			);
		}

		for (const artifact of input.artifacts) {
			await tx
				.insert(conversationArtifacts)
				.values({
					...artifact,
					userId: input.owner.userId,
					conversationId: input.owner.conversationId,
				})
				.onConflictDoUpdate({
					target: [
						conversationArtifacts.userId,
						conversationArtifacts.conversationId,
						conversationArtifacts.path,
					],
					set: {
						objectKey: artifact.objectKey,
						sizeBytes: artifact.sizeBytes,
						contentType: artifact.contentType,
						updatedAt: sql`now()`,
					},
				});
		}

		const supersededKeys = existing
			.map((artifact) => artifact.objectKey)
			.filter((key) => !objectKeys.includes(key));
		if (supersededKeys.length > 0) {
			await tx
				.update(artifactObjects)
				.set({ status: "superseded", supersededAt: sql`now()` })
				.where(inArray(artifactObjects.objectKey, supersededKeys));
		}

		const run = await transitionRunTerminalInTx(tx, {
			runId: input.owner.runId,
			workerId: input.owner.workerId,
			status: "done",
		});
		return { run, agentSessionPointerAdvanced };
	});
}

function validatePublishedArtifacts(artifacts: PublishedArtifact[]): void {
	const paths = new Set<string>();
	for (const artifact of artifacts) {
		if (!Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
			throw new Error("artifact publication contains an invalid size");
		}
		if (artifact.sizeBytes > MAX_ARTIFACT_SIZE_BYTES) {
			throw new ArtifactQuotaError(
				"artifact_size_bytes",
				artifact.sizeBytes,
				MAX_ARTIFACT_SIZE_BYTES,
			);
		}
		if (paths.has(artifact.path)) {
			throw new Error("artifact publication contains duplicate paths");
		}
		paths.add(artifact.path);
	}
}

function validatePostUpsertQuota(
	current: Array<{ path: string; sizeBytes: number }>,
	changed: PublishedArtifact[],
): void {
	const resultingSizes = new Map(
		current.map((artifact) => [artifact.path, artifact.sizeBytes]),
	);
	for (const artifact of changed) {
		resultingSizes.set(artifact.path, artifact.sizeBytes);
	}
	if (resultingSizes.size > MAX_CURRENT_ARTIFACT_PATHS) {
		throw new ArtifactQuotaError(
			"conversation_path_count",
			resultingSizes.size,
			MAX_CURRENT_ARTIFACT_PATHS,
		);
	}
	let totalSize = 0;
	for (const size of resultingSizes.values()) totalSize += size;
	if (totalSize > MAX_CONVERSATION_ARTIFACT_BYTES) {
		throw new ArtifactQuotaError(
			"conversation_size_bytes",
			totalSize,
			MAX_CONVERSATION_ARTIFACT_BYTES,
		);
	}
}
