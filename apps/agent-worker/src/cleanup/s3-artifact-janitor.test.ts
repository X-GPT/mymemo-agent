import { describe, expect, it } from "bun:test";
import type { DeleteObjectCommandInput } from "@aws-sdk/client-s3";
import { createS3ArtifactObjectJanitor } from "./s3-artifact-janitor";

describe("S3 Downloadable artifact janitor", () => {
	it("deletes only the ledger-named object from the private bucket", async () => {
		const calls: DeleteObjectCommandInput[] = [];
		const janitor = createS3ArtifactObjectJanitor(
			{ bucket: "private-artifacts", region: "us-west-2" },
			{
				async deleteObject(request) {
					calls.push(request);
				},
			},
		);

		await janitor.deleteObject("objects/opaque");

		expect(calls).toEqual([
			{ Bucket: "private-artifacts", Key: "objects/opaque" },
		]);
	});
});
