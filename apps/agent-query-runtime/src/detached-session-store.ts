import {
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";

export const MAX_DETACHED_SESSION_BYTES = 100 * 1024 * 1024;

export interface DetachedSessionStore {
	load(conversationId: string): Promise<unknown | null>;
	save(conversationId: string, state: unknown): Promise<void>;
}

export function createS3DetachedSessionStore(config: {
	bucket: string;
	client: S3Client;
}): DetachedSessionStore {
	return {
		async load(conversationId: string): Promise<unknown | null> {
			try {
				const response = await config.client.send(
					new GetObjectCommand({
						Bucket: config.bucket,
						Key: `agent-sessions/${conversationId}`,
					}),
				);
				if (!response.Body) throw new Error("Agent session object has no body");
				return JSON.parse(await response.Body.transformToString());
			} catch (error) {
				if (
					typeof error === "object" &&
					error !== null &&
					"$metadata" in error &&
					(error.$metadata as { httpStatusCode?: number }).httpStatusCode ===
						404
				) {
					return null;
				}
				throw error;
			}
		},
		async save(conversationId, state) {
			const body = new TextEncoder().encode(JSON.stringify(state));
			if (body.byteLength > MAX_DETACHED_SESSION_BYTES) {
				throw new Error("Detached Agent session exceeds 100 MiB");
			}
			await config.client.send(
				new PutObjectCommand({
					Bucket: config.bucket,
					Key: `agent-sessions/${conversationId}`,
					Body: body,
					ContentType: "application/json",
				}),
			);
		},
	};
}
