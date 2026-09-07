import {
	DeleteObjectCommand,
	DeleteObjectsCommand,
	ListObjectsV2Command,
	type S3Client,
} from "@aws-sdk/client-s3";

export async function deleteConversationObjects(
	s3: S3Client,
	bucket: string,
	id: string,
) {
	for (const prefix of ["_workspace", "_artifacts", "_history"]) {
		await deletePrefix(s3, bucket, `${prefix}/${id}/`);
	}
	await s3.send(
		new DeleteObjectCommand({
			Bucket: bucket,
			Key: `_transcripts/${id}.jsonl`,
		}),
	);
}

export async function deletePrefix(
	s3: S3Client,
	bucket: string,
	prefix: string,
) {
	let cursor: string | undefined;
	do {
		const page = await s3.send(
			new ListObjectsV2Command({
				Bucket: bucket,
				Prefix: prefix,
				ContinuationToken: cursor,
			}),
		);
		if (page.Contents?.length) {
			const result = await s3.send(
				new DeleteObjectsCommand({
					Bucket: bucket,
					Delete: {
						Objects: page.Contents.map(({ Key }) => ({ Key })),
						Quiet: true,
					},
				}),
			);
			if (result.Errors?.length)
				throw new Error("Conversation object cleanup failed");
		}
		cursor = page.NextContinuationToken;
	} while (cursor);
}
