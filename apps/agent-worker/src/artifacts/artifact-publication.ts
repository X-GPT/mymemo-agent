import {
	type PublishedArtifact,
	recordArtifactObjectsTx,
} from "@mymemo/agent-db/artifact-store";
import type { Database } from "@mymemo/agent-db/client";
import type { RunRecord } from "@mymemo/agent-db/run-store";
import type { SupervisedQuery } from "../sdk/agent-stream";

export interface ArtifactManifestEntry {
	path: string;
	sizeBytes: number;
	modifiedAt: string;
}

/** Trusted-worker view of the reserved artifact subtree in one live workspace. */
export interface ArtifactWorkspace {
	captureManifest(signal: AbortSignal): Promise<ArtifactManifestEntry[]>;
	readFile(path: string, signal: AbortSignal): Promise<Uint8Array>;
}

/** Private object-store boundary. Production uses S3; tests retain exact bytes. */
export interface ArtifactObjectStore {
	upload(input: {
		objectKey: string;
		body: Uint8Array;
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
			const baseline = manifestByPath(await workspace.captureManifest(signal));
			throwIfAborted(signal);
			let published = false;
			return {
				async publish() {
					if (published)
						throw new Error("artifact publication already attempted");
					published = true;
					throwIfAborted(signal);
					const finalManifest = await workspace.captureManifest(signal);
					throwIfAborted(signal);
					const changed = finalManifest
						.filter((entry) => manifestChanged(baseline.get(entry.path), entry))
						.sort((left, right) => left.path.localeCompare(right.path));
					if (changed.length === 0) return null;

					const artifacts = changed.map((entry) => ({
						artifactId: createArtifactId(),
						path: entry.path,
						objectKey: createObjectKey(),
						sizeBytes: entry.sizeBytes,
						contentType: "application/octet-stream",
					}));
					await recordArtifactObjectsTx(deps.db, {
						objects: artifacts.map((artifact) => ({
							objectKey: artifact.objectKey,
							userId: run.userId,
							conversationId: run.conversationId,
							runId: run.runId,
							path: artifact.path,
						})),
					});

					for (const artifact of artifacts) {
						throwIfAborted(signal);
						const body = await workspace.readFile(artifact.path, signal);
						throwIfAborted(signal);
						await deps.objectStore.upload({
							objectKey: artifact.objectKey,
							body,
							signal,
						});
					}
					throwIfAborted(signal);
					return { artifacts };
				},
			};
		},
	};
}

/** Publish only after the SDK stream ends cleanly; errors/cancel skip finish. */
export function withArtifactPublication(
	query: SupervisedQuery,
	session: ArtifactPublicationSession,
): ArtifactAwareQuery {
	let publication: ArtifactPublication | null = null;
	return {
		interrupt: () => query.interrupt(),
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
