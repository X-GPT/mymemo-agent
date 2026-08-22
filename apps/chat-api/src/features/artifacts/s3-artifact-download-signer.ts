import {
	GetObjectCommand,
	type GetObjectCommandInput,
	S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
	ArtifactDownloadSigner,
	ArtifactDownloadSignInput,
} from "./artifact-download-signer";

export interface ArtifactBucketConfig {
	bucket: string;
	region: string;
}

export type PresignGetObject = (
	request: GetObjectCommandInput,
	expiresInSeconds: number,
) => Promise<string>;

export interface S3ArtifactDownloadSignerDependencies {
	endpoint?: string;
	presignGetObject?: PresignGetObject;
}

/**
 * Build the private-S3 signer. The presign operation is injectable so request
 * semantics are testable without credentials, a network, or a live bucket.
 */
export function createS3ArtifactDownloadSigner(
	config: ArtifactBucketConfig,
	dependencies: S3ArtifactDownloadSignerDependencies = {},
): ArtifactDownloadSigner {
	const presignGetObject =
		dependencies.presignGetObject ??
		(() => {
			const client = new S3Client({
				region: config.region,
				...(dependencies.endpoint
					? { endpoint: dependencies.endpoint, forcePathStyle: true }
					: {}),
			});
			return (request: GetObjectCommandInput, expiresInSeconds: number) =>
				getSignedUrl(client, new GetObjectCommand(request), {
					expiresIn: expiresInSeconds,
				});
		})();

	return {
		createDownloadUrl(input: ArtifactDownloadSignInput): Promise<string> {
			return presignGetObject(
				{
					Bucket: config.bucket,
					Key: input.objectKey,
					ResponseContentDisposition: input.responseContentDisposition,
					ResponseContentType: input.responseContentType,
				},
				input.expiresInSeconds,
			);
		},
	};
}
