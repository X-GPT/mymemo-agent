import {
	AbortMultipartUploadCommand,
	type AbortMultipartUploadCommandInput,
	CompleteMultipartUploadCommand,
	type CompleteMultipartUploadCommandInput,
	CreateMultipartUploadCommand,
	type CreateMultipartUploadCommandInput,
	PutObjectCommand,
	type PutObjectCommandInput,
	S3Client,
	UploadPartCommand,
	type UploadPartCommandInput,
} from "@aws-sdk/client-s3";
import type { ArtifactObjectStore } from "./artifact-publication";

export interface ArtifactBucketConfig {
	bucket: string;
	region: string;
}

const MULTIPART_PART_SIZE_BYTES = 5 * 1_024 * 1_024;

export type PutArtifactObject = (
	request: PutObjectCommandInput,
	signal: AbortSignal,
) => Promise<void>;

export interface ArtifactObjectStoreDependencies {
	putObject?: PutArtifactObject;
	createMultipartUpload?: (
		request: CreateMultipartUploadCommandInput,
		signal: AbortSignal,
	) => Promise<string>;
	uploadPart?: (
		request: UploadPartCommandInput,
		signal: AbortSignal,
	) => Promise<string>;
	completeMultipartUpload?: (
		request: CompleteMultipartUploadCommandInput,
		signal: AbortSignal,
	) => Promise<void>;
	abortMultipartUpload?: (
		request: AbortMultipartUploadCommandInput,
	) => Promise<void>;
}

/** S3 retries each bounded byte payload with its standard three-attempt strategy. */
export function createS3ArtifactObjectStore(
	config: ArtifactBucketConfig,
	dependencies: ArtifactObjectStoreDependencies = {},
): ArtifactObjectStore {
	const client = new S3Client({ region: config.region, maxAttempts: 3 });
	const putObject =
		dependencies.putObject ??
		(async (request: PutObjectCommandInput, signal: AbortSignal) => {
			await client.send(new PutObjectCommand(request), { abortSignal: signal });
		});
	const createMultipartUpload =
		dependencies.createMultipartUpload ??
		(async (
			request: CreateMultipartUploadCommandInput,
			signal: AbortSignal,
		) => {
			const result = await client.send(
				new CreateMultipartUploadCommand(request),
				{
					abortSignal: signal,
				},
			);
			if (!result.UploadId) throw new Error("artifact multipart upload failed");
			return result.UploadId;
		});
	const uploadPart =
		dependencies.uploadPart ??
		(async (request: UploadPartCommandInput, signal: AbortSignal) => {
			const result = await client.send(new UploadPartCommand(request), {
				abortSignal: signal,
			});
			if (!result.ETag) throw new Error("artifact multipart upload failed");
			return result.ETag;
		});
	const completeMultipartUpload =
		dependencies.completeMultipartUpload ??
		(async (
			request: CompleteMultipartUploadCommandInput,
			signal: AbortSignal,
		) => {
			await client.send(new CompleteMultipartUploadCommand(request), {
				abortSignal: signal,
			});
		});
	const abortMultipartUpload =
		dependencies.abortMultipartUpload ??
		(async (request: AbortMultipartUploadCommandInput) => {
			await client.send(new AbortMultipartUploadCommand(request));
		});

	return {
		async upload({ objectKey, body, sizeBytes, contentType, signal }) {
			if (sizeBytes <= MULTIPART_PART_SIZE_BYTES) {
				const bytes = await collectBody(body, sizeBytes, signal);
				await putObject(
					{
						Bucket: config.bucket,
						Key: objectKey,
						Body: bytes,
						ContentLength: bytes.byteLength,
						ContentType: contentType,
					},
					signal,
				);
				return;
			}

			const baseRequest = { Bucket: config.bucket, Key: objectKey };
			const uploadId = await createMultipartUpload(
				{ ...baseRequest, ContentType: contentType },
				signal,
			);
			try {
				const parts: Array<{ PartNumber: number; ETag: string }> = [];
				let partNumber = 1;
				for await (const part of streamParts(body, sizeBytes, signal)) {
					const etag = await uploadPart(
						{
							...baseRequest,
							UploadId: uploadId,
							PartNumber: partNumber,
							Body: part,
							ContentLength: part.byteLength,
						},
						signal,
					);
					parts.push({ PartNumber: partNumber, ETag: etag });
					partNumber++;
				}
				await completeMultipartUpload(
					{
						...baseRequest,
						UploadId: uploadId,
						MultipartUpload: { Parts: parts },
					},
					signal,
				);
			} catch (error) {
				await abortMultipartUpload({
					...baseRequest,
					UploadId: uploadId,
				}).catch(() => {});
				throw error;
			}
		},
	};
}

async function collectBody(
	body: ReadableStream<Uint8Array>,
	expectedSize: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const bytes = new Uint8Array(expectedSize);
	const reader = body.getReader();
	let offset = 0;
	let complete = false;
	try {
		while (true) {
			const result = await readWithAbort(reader, signal);
			if (result.done) break;
			if (offset + result.value.byteLength > expectedSize) {
				throw new Error("artifact upload size mismatch");
			}
			bytes.set(result.value, offset);
			offset += result.value.byteLength;
		}
		if (offset !== expectedSize) {
			throw new Error("artifact upload size mismatch");
		}
		complete = true;
		return bytes;
	} finally {
		if (!complete) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function* streamParts(
	body: ReadableStream<Uint8Array>,
	expectedSize: number,
	signal: AbortSignal,
): AsyncGenerator<Uint8Array> {
	const reader = body.getReader();
	let part = new Uint8Array(MULTIPART_PART_SIZE_BYTES);
	let partOffset = 0;
	let total = 0;
	let complete = false;
	try {
		while (true) {
			const result = await readWithAbort(reader, signal);
			if (result.done) break;
			total += result.value.byteLength;
			if (total > expectedSize) {
				throw new Error("artifact upload size mismatch");
			}

			let chunkOffset = 0;
			while (chunkOffset < result.value.byteLength) {
				const copied = Math.min(
					part.byteLength - partOffset,
					result.value.byteLength - chunkOffset,
				);
				part.set(
					result.value.subarray(chunkOffset, chunkOffset + copied),
					partOffset,
				);
				partOffset += copied;
				chunkOffset += copied;
				if (partOffset === part.byteLength) {
					yield part;
					part = new Uint8Array(MULTIPART_PART_SIZE_BYTES);
					partOffset = 0;
				}
			}
		}
		if (total !== expectedSize) {
			throw new Error("artifact upload size mismatch");
		}
		complete = true;
		if (partOffset > 0) yield part.slice(0, partOffset);
	} finally {
		if (!complete) await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

interface ArtifactStreamReader {
	read(): Promise<
		{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
	>;
	cancel(reason?: unknown): Promise<void>;
}

function readWithAbort(
	reader: ArtifactStreamReader,
	signal: AbortSignal,
): Promise<
	{ done: false; value: Uint8Array } | { done: true; value?: Uint8Array }
> {
	if (signal.aborted) {
		void reader.cancel(signal.reason).catch(() => {});
		return Promise.reject(
			signal.reason ?? new Error("artifact upload aborted"),
		);
	}
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			void reader.cancel(signal.reason).catch(() => {});
			reject(signal.reason ?? new Error("artifact upload aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		reader.read().then(
			(result) => {
				signal.removeEventListener("abort", onAbort);
				resolve(result);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}
