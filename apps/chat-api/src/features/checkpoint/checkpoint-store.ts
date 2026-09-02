import type { Readable } from "node:stream";
import {
	DeleteObjectCommand,
	GetObjectCommand,
	NoSuchKey,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";

/**
 * Checkpoint bytes in the MicroVM checkpoint bucket (#670). One object per
 * durable Checkpoint under `conversations/<conversation-id>/`; the
 * `conversation_vm.checkpoint_pointer` names the current one. chat-api is
 * the only principal that touches this bucket: the VM has no network path to
 * S3, so it hands its Checkpoint to the `/v2/checkpoint` route, which
 * streams it here. Injectable so the route is testable without credentials.
 */
export interface CheckpointStore {
	/** Stream `body` (exactly `length` bytes) to `key`. */
	put(key: string, body: Readable, length: number): Promise<void>;
	/** The object's bytes and size, or null when the key does not exist. */
	get(
		key: string,
	): Promise<{ body: ReadableStream<Uint8Array>; length: number } | null>;
	delete(key: string): Promise<void>;
}

export function createS3CheckpointStore(
	config: { bucket: string; region: string },
	client: Pick<S3Client, "send"> = new S3Client({ region: config.region }),
): CheckpointStore {
	const Bucket = config.bucket;
	return {
		async put(Key, Body, ContentLength) {
			await client.send(
				new PutObjectCommand({
					Bucket,
					Key,
					Body,
					ContentLength,
					ContentType: "application/gzip",
				}),
			);
		},
		async get(Key) {
			try {
				const object = await client.send(new GetObjectCommand({ Bucket, Key }));
				if (!object.Body || object.ContentLength === undefined) return null;
				return {
					body: object.Body.transformToWebStream(),
					length: object.ContentLength,
				};
			} catch (error) {
				if (error instanceof NoSuchKey) return null;
				throw error;
			}
		},
		async delete(Key) {
			await client.send(new DeleteObjectCommand({ Bucket, Key }));
		},
	};
}
