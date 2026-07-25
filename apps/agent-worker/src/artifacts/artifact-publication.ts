import {
	ArtifactQuotaError,
	MAX_ARTIFACT_SIZE_BYTES,
	type PublishedArtifact,
	recordArtifactObjectsTx,
} from "@mymemo/agent-db/artifact-store";
import type { Database } from "@mymemo/agent-db/client";
import type { RunRecord } from "@mymemo/agent-db/run-store";
import type { SupervisedQuery } from "../sdk/agent-stream";
import { artifactContentType } from "./artifact-content-type";
import {
	type ArtifactManifestEntry,
	ArtifactValidationError,
	validateArtifactManifest,
} from "./artifact-manifest";

export type ArtifactPublicationStage =
	| "ledger"
	| "manifest"
	| "read"
	| "upload";

/** Safe publication-stage detail suitable for structured worker logs. */
export class ArtifactPublicationError extends Error {
	override readonly name = "ArtifactPublicationError";

	constructor(readonly stage: ArtifactPublicationStage) {
		super(`artifact publication failed: ${stage}`);
	}
}

/** Trusted-worker view of the reserved artifact subtree in one live workspace. */
export interface ArtifactWorkspace {
	captureManifest(signal: AbortSignal): Promise<ArtifactManifestEntry[]>;
	openFile(
		entry: ArtifactManifestEntry,
		signal: AbortSignal,
	): Promise<ReadableStream<Uint8Array>>;
}

/** Private object-store boundary. Production uses S3; tests retain exact bytes. */
export interface ArtifactObjectStore {
	upload(input: {
		objectKey: string;
		body: ReadableStream<Uint8Array>;
		sizeBytes: number;
		contentType: string;
		signal: AbortSignal;
	}): Promise<void>;
}

export interface ArtifactPublication {
	artifacts: PublishedArtifact[];
}

export interface ArtifactPublicationSession {
	publish(): Promise<ArtifactPublication | null>;
}

export interface ArtifactAwareQuery extends SupervisedQuery {
	getArtifactPublication(): ArtifactPublication | null;
}

export interface ArtifactPublisher {
	begin(input: {
		run: RunRecord;
		workspace: ArtifactWorkspace;
		signal: AbortSignal;
	}): Promise<ArtifactPublicationSession>;
}

export interface ArtifactPublisherDependencies {
	db: Database;
	objectStore: ArtifactObjectStore;
	createObjectKey?: () => string;
	createArtifactId?: () => string;
}

/**
 * Capture the Run's baseline now, then return a session that compares the
 * final manifest, ledgers every intended object, and uploads changed files.
 * Metadata remains non-current until the Run loop's fenced success transaction.
 */
export function createArtifactPublisher(
	deps: ArtifactPublisherDependencies,
): ArtifactPublisher {
	const createObjectKey =
		deps.createObjectKey ?? (() => `objects/${crypto.randomUUID()}`);
	const createArtifactId = deps.createArtifactId ?? (() => crypto.randomUUID());
	return {
		async begin({ run, workspace, signal }) {
			throwIfAborted(signal);
			const baseline = manifestByPath(
				await captureValidatedManifest(workspace, signal),
			);
			throwIfAborted(signal);
			let published = false;
			return {
				async publish() {
					if (published)
						throw new Error("artifact publication already attempted");
					published = true;
					throwIfAborted(signal);
					const finalManifest = await captureValidatedManifest(
						workspace,
						signal,
					);
					throwIfAborted(signal);
					const changed = finalManifest
						.filter((entry) => manifestChanged(baseline.get(entry.path), entry))
						.sort((left, right) => left.path.localeCompare(right.path));
					if (changed.length === 0) return null;
					for (const entry of changed) {
						if (entry.sizeBytes > MAX_ARTIFACT_SIZE_BYTES) {
							throw new ArtifactQuotaError(
								"artifact_size_bytes",
								entry.sizeBytes,
								MAX_ARTIFACT_SIZE_BYTES,
							);
						}
					}

					const candidates = changed.map((entry) => ({
						entry,
						artifact: {
							artifactId: createArtifactId(),
							path: entry.path,
							objectKey: createObjectKey(),
							sizeBytes: entry.sizeBytes,
							contentType: artifactContentType(entry.path),
						},
					}));
					const artifacts = candidates.map(({ artifact }) => artifact);
					try {
						await recordArtifactObjectsTx(deps.db, {
							objects: artifacts.map((artifact) => ({
								objectKey: artifact.objectKey,
								userId: run.userId,
								conversationId: run.conversationId,
								runId: run.runId,
								path: artifact.path,
							})),
						});
					} catch {
						throw new ArtifactPublicationError("ledger");
					}

					for (const { artifact, entry } of candidates) {
						throwIfAborted(signal);
						let body: ReadableStream<Uint8Array>;
						try {
							body = await workspace.openFile(entry, signal);
						} catch (error) {
							throwIfAborted(signal);
							if (error instanceof ArtifactValidationError) throw error;
							throw new ArtifactPublicationError("read");
						}
						if (signal.aborted) {
							await body.cancel(signal.reason).catch(() => {});
							throwIfAborted(signal);
						}
						try {
							await deps.objectStore.upload({
								objectKey: artifact.objectKey,
								body,
								sizeBytes: artifact.sizeBytes,
								contentType: artifact.contentType,
								signal,
							});
						} catch {
							await body.cancel(signal.reason).catch(() => {});
							throwIfAborted(signal);
							throw new ArtifactPublicationError("upload");
						}
					}
					throwIfAborted(signal);
					return { artifacts };
				},
			};
		},
	};
}

async function captureValidatedManifest(
	workspace: ArtifactWorkspace,
	signal: AbortSignal,
): Promise<ArtifactManifestEntry[]> {
	try {
		return validateArtifactManifest(await workspace.captureManifest(signal));
	} catch (error) {
		throwIfAborted(signal);
		if (error instanceof ArtifactValidationError) throw error;
		throw new ArtifactPublicationError("manifest");
	}
}

/** Publish only after the SDK stream ends cleanly; errors/cancel skip finish. */
export function withArtifactPublication(
	query: SupervisedQuery,
	session: ArtifactPublicationSession,
): ArtifactAwareQuery {
	let publication: ArtifactPublication | null = null;
	return {
		interrupt: () => query.interrupt(),
		close: () => query.close(),
		...(query.forceCloseSignal
			? { forceCloseSignal: query.forceCloseSignal }
			: {}),
		getArtifactPublication: () => publication,
		async *[Symbol.asyncIterator]() {
			for await (const message of query) yield message;
			publication = await session.publish();
		},
	};
}

function manifestByPath(
	manifest: ArtifactManifestEntry[],
): Map<string, ArtifactManifestEntry> {
	return new Map(manifest.map((entry) => [entry.path, entry]));
}

function manifestChanged(
	baseline: ArtifactManifestEntry | undefined,
	finalEntry: ArtifactManifestEntry,
): boolean {
	return (
		baseline === undefined ||
		baseline.sizeBytes !== finalEntry.sizeBytes ||
		baseline.modifiedAt !== finalEntry.modifiedAt
	);
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted)
		throw signal.reason ?? new Error("artifact publication aborted");
}
