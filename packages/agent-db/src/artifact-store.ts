import { and, eq, inArray, sql } from "drizzle-orm";
import type { Database } from "./client";
import { type RunRecord, transitionRunTerminalInTx } from "./run-store";
import {
	artifactObjects,
	conversationArtifacts,
	conversationRuntime,
} from "./schema";

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
		runId: string;
		workerId: string;
		userId: string;
		conversationId: string;
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
	return await db.transaction(async (tx) => {
		let agentSessionPointerAdvanced: boolean | null = null;
		if (input.agentSessionId !== undefined) {
			try {
				await tx.transaction(async (savepoint) => {
					const [runtime] = await savepoint
						.update(conversationRuntime)
						.set({
							agentSessionId: input.agentSessionId,
							updatedAt: sql`now()`,
						})
						.where(
							and(
								eq(conversationRuntime.userId, input.userId),
								eq(conversationRuntime.conversationId, input.conversationId),
							),
						)
						.returning({ conversationId: conversationRuntime.conversationId });
					if (!runtime) throw new Error("conversation runtime row is missing");
				});
				agentSessionPointerAdvanced = true;
			} catch {
				agentSessionPointerAdvanced = false;
			}
		}
		const paths = input.artifacts.map((artifact) => artifact.path);
		const existing = await tx
			.select({ objectKey: conversationArtifacts.objectKey })
			.from(conversationArtifacts)
			.where(
				and(
					eq(conversationArtifacts.userId, input.userId),
					eq(conversationArtifacts.conversationId, input.conversationId),
					inArray(conversationArtifacts.path, paths),
				),
			);

		const objectKeys = input.artifacts.map((artifact) => artifact.objectKey);
		const promoted = await tx
			.update(artifactObjects)
			.set({ status: "current", committedAt: sql`now()` })
			.where(
				and(
					inArray(artifactObjects.objectKey, objectKeys),
					eq(artifactObjects.userId, input.userId),
					eq(artifactObjects.conversationId, input.conversationId),
					eq(artifactObjects.runId, input.runId),
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
					userId: input.userId,
					conversationId: input.conversationId,
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
			runId: input.runId,
			workerId: input.workerId,
			status: "done",
		});
		return { run, agentSessionPointerAdvanced };
	});
}
