import type { Database } from "@mymemo/agent-db/client";
import { conversationArtifacts } from "@mymemo/agent-db/schema";
import { and, asc, eq } from "drizzle-orm";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";
import type {
	ArtifactMetadata,
	ArtifactMetadataStore,
	CurrentArtifact,
	CurrentArtifactRef,
} from "./artifact-metadata-store";

/** Drizzle adapter over the authoritative current Downloadable artifact rows. */
export class PostgresArtifactMetadataStore implements ArtifactMetadataStore {
	constructor(private readonly db: Database) {}

	async listCurrent(ref: ConversationRef): Promise<ArtifactMetadata[]> {
		return this.db
			.select({
				artifactId: conversationArtifacts.artifactId,
				path: conversationArtifacts.path,
				sizeBytes: conversationArtifacts.sizeBytes,
				contentType: conversationArtifacts.contentType,
				createdAt: conversationArtifacts.createdAt,
				updatedAt: conversationArtifacts.updatedAt,
			})
			.from(conversationArtifacts)
			.where(
				and(
					eq(conversationArtifacts.userId, ref.userId),
					eq(conversationArtifacts.conversationId, ref.conversationId),
				),
			)
			.orderBy(asc(conversationArtifacts.path));
	}

	async getCurrent(ref: CurrentArtifactRef): Promise<CurrentArtifact | null> {
		const rows = await this.db
			.select({
				artifactId: conversationArtifacts.artifactId,
				path: conversationArtifacts.path,
				objectKey: conversationArtifacts.objectKey,
				sizeBytes: conversationArtifacts.sizeBytes,
				contentType: conversationArtifacts.contentType,
				createdAt: conversationArtifacts.createdAt,
				updatedAt: conversationArtifacts.updatedAt,
			})
			.from(conversationArtifacts)
			.where(
				and(
					eq(conversationArtifacts.userId, ref.userId),
					eq(conversationArtifacts.conversationId, ref.conversationId),
					eq(conversationArtifacts.artifactId, ref.artifactId),
				),
			)
			.limit(1);
		return rows[0] ?? null;
	}
}
