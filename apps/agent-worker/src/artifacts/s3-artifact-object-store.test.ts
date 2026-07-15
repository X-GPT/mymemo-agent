import { describe, expect, it } from "bun:test";
import type { PutObjectCommandInput } from "@aws-sdk/client-s3";
import { createS3ArtifactObjectStore } from "./s3-artifact-object-store";

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
		const body = new Uint8Array([0, 255, 1]);

		await store.upload({
			objectKey: "objects/opaque",
			body,
			signal: controller.signal,
		});

		expect(calls).toEqual([
			{
				request: {
					Bucket: "private-artifacts",
					Key: "objects/opaque",
					Body: body,
				},
				signal: controller.signal,
			},
		]);
	});
});
