import { describe, expect, it } from "bun:test";
import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { createS3ArtifactObjectStore } from "./s3-artifact-object-store";

const MIB = 1_024 * 1_024;

function byteStream(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
			controller.close();
		},
	});
}

describe("S3 Downloadable artifact object store", () => {
	it("uploads to the private configured bucket and propagates abort", async () => {
		const calls: Array<{
			request: PutObjectCommandInput;
			signal: AbortSignal;
		}> = [];
		const store = createS3ArtifactObjectStore(
			{ bucket: "private-artifacts", region: "us-west-2" },
			{
				async putObject(request, signal) {
					calls.push({ request, signal });
				},
			},
		);
		const controller = new AbortController();
		const body = byteStream([new Uint8Array([0, 255, 1])]);
		const expectedBody = new Uint8Array([0, 255, 1]);

		await store.upload({
			objectKey: "objects/opaque",
			body,
			sizeBytes: 3,
			contentType: "application/octet-stream",
			signal: controller.signal,
		});

		expect(calls).toEqual([
			{
				request: {
					Bucket: "private-artifacts",
					Key: "objects/opaque",
					Body: expectedBody,
					ContentLength: 3,
					ContentType: "application/octet-stream",
				},
				signal: controller.signal,
			},
		]);
	});

	it("uploads large streams as bounded retryable multipart chunks", async () => {
		const partSizes: number[] = [];
		const completed: Array<{ PartNumber?: number; ETag?: string }> = [];
		let initiatedContentType: string | undefined;
		let aborted = false;
		const store = createS3ArtifactObjectStore(
			{ bucket: "private-artifacts", region: "us-west-2" },
			{
				async putObject() {
					throw new Error("large upload must not use PutObject");
				},
				async createMultipartUpload(request) {
					initiatedContentType = request.ContentType;
					return "upload-1";
				},
				async uploadPart(request) {
					partSizes.push((request.Body as Uint8Array).byteLength);
					return `etag-${request.PartNumber}`;
				},
				async completeMultipartUpload(request) {
					completed.push(...(request.MultipartUpload?.Parts ?? []));
				},
				async abortMultipartUpload() {
					aborted = true;
				},
			},
		);
		const sizeBytes = 5 * MIB + 7;

		await store.upload({
			objectKey: "objects/large",
			body: byteStream([new Uint8Array(3 * MIB), new Uint8Array(2 * MIB + 7)]),
			sizeBytes,
			contentType: "application/pdf",
			signal: new AbortController().signal,
		});

		expect(partSizes).toEqual([5 * MIB, 7]);
		expect(completed).toEqual([
			{ PartNumber: 1, ETag: "etag-1" },
			{ PartNumber: 2, ETag: "etag-2" },
		]);
		expect(initiatedContentType).toBe("application/pdf");
		expect(aborted).toBe(false);
	});

	it("aborts multipart publication when the stream length differs from the manifest", async () => {
		let completed = false;
		let aborted = false;
		const store = createS3ArtifactObjectStore(
			{ bucket: "private-artifacts", region: "us-west-2" },
			{
				async createMultipartUpload() {
					return "upload-1";
				},
				async uploadPart() {
					return "etag-1";
				},
				async completeMultipartUpload() {
					completed = true;
				},
				async abortMultipartUpload() {
					aborted = true;
				},
			},
		);

		await expect(
			store.upload({
				objectKey: "objects/truncated",
				body: byteStream([new Uint8Array(5 * MIB)]),
				sizeBytes: 5 * MIB + 1,
				contentType: "application/octet-stream",
				signal: new AbortController().signal,
			}),
		).rejects.toThrow(/size/);
		expect(completed).toBe(false);
		expect(aborted).toBe(true);
	});

	it("propagates caller abort through multipart upload and aborts the upload id", async () => {
		const controller = new AbortController();
		let aborted = false;
		const store = createS3ArtifactObjectStore(
			{ bucket: "private-artifacts", region: "us-west-2" },
			{
				async createMultipartUpload() {
					return "upload-1";
				},
				async uploadPart(_request, signal) {
					expect(signal).toBe(controller.signal);
					controller.abort(new Error("publication canceled"));
					throw signal.reason;
				},
				async abortMultipartUpload() {
					aborted = true;
				},
			},
		);

		await expect(
			store.upload({
				objectKey: "objects/canceled",
				body: byteStream([new Uint8Array(5 * MIB + 1)]),
				sizeBytes: 5 * MIB + 1,
				contentType: "application/octet-stream",
				signal: controller.signal,
			}),
		).rejects.toThrow("publication canceled");
		expect(aborted).toBe(true);
	});
});
