import type { ConversationRef } from "@/features/conversation-store";

/** Public metadata returned by the complete current-artifact list. */
export interface ArtifactMetadata {
	artifactId: string;
	path: string;
	sizeBytes: number;
	contentType: string;
	createdAt: Date;
	updatedAt: Date;
}

/** Internal current record needed to authorize and sign one download. */
export interface CurrentArtifact extends ArtifactMetadata {
	objectKey: string;
}

export interface CurrentArtifactRef extends ConversationRef {
	artifactId: string;
}

/** Postgres-backed current-artifact read model; never derives state from S3. */
export interface ArtifactMetadataStore {
	listCurrent(ref: ConversationRef): Promise<ArtifactMetadata[]>;
	getCurrent(ref: CurrentArtifactRef): Promise<CurrentArtifact | null>;
}
