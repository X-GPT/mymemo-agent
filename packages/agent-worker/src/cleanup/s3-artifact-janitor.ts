import {
	DeleteObjectCommand,
	type DeleteObjectCommandInput,
	S3Client,
} from "@aws-sdk/client-s3";
import type { ArtifactBucketConfig } from "../artifacts/s3-artifact-object-store";
import type { ArtifactObjectJanitor } from "./cleanup";

export type DeleteArtifactObject = (
	request: DeleteObjectCommandInput,
) => Promise<void>;

/** S3 delete is idempotent and uses the client's bounded retry strategy. */
export function createS3ArtifactObjectJanitor(
	config: ArtifactBucketConfig,
	dependencies: { deleteObject?: DeleteArtifactObject } = {},
): ArtifactObjectJanitor {
	const deleteObject =
		dependencies.deleteObject ??
		(() => {
			const client = new S3Client({ region: config.region, maxAttempts: 3 });
			return async (request: DeleteObjectCommandInput) => {
				await client.send(new DeleteObjectCommand(request));
			};
		})();

	return {
		async deleteObject(objectKey) {
			await deleteObject({ Bucket: config.bucket, Key: objectKey });
		},
	};
}
