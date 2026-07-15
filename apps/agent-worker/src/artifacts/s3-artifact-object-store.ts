import {
	PutObjectCommand,
	type PutObjectCommandInput,
	S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactObjectStore } from "./artifact-publication";

export interface ArtifactBucketConfig {
	bucket: string;
	region: string;
}

export type PutArtifactObject = (
	request: PutObjectCommandInput,
	signal: AbortSignal,
) => Promise<void>;

/** S3 retries are bounded by the client's standard three-attempt strategy. */
export function createS3ArtifactObjectStore(
	config: ArtifactBucketConfig,
	dependencies: { putObject?: PutArtifactObject } = {},
): ArtifactObjectStore {
	const putObject =
		dependencies.putObject ??
		(() => {
			const client = new S3Client({ region: config.region, maxAttempts: 3 });
			return async (request: PutObjectCommandInput, signal: AbortSignal) => {
				await client.send(new PutObjectCommand(request), {
					abortSignal: signal,
				});
			};
		})();
	return {
		async upload({ objectKey, body, signal }) {
			await putObject(
				{
					Bucket: config.bucket,
					Key: objectKey,
					Body: body,
				},
				signal,
			);
		},
	};
}
