import { describe, expect, it } from "bun:test";
import type { GetObjectCommandInput } from "@aws-sdk/client-s3";
import { createS3ArtifactDownloadSigner } from "./s3-artifact-download-signer";

describe("createS3ArtifactDownloadSigner", () => {
	it("presigns only the selected object with response header overrides and caller expiry", async () => {
		const seen: Array<{
			request: GetObjectCommandInput;
			expiresInSeconds: number;
		}> = [];
		const signer = createS3ArtifactDownloadSigner(
			{
				bucket: "private-artifact-bucket",
				region: "us-west-2",
			},
			{
				async presignGetObject(request, expiresInSeconds) {
					seen.push({ request, expiresInSeconds });
					return "https://objects.example/fresh-signature";
				},
			},
		);

		await expect(
			signer.createDownloadUrl({
				objectKey: "opaque/run/object",
				expiresInSeconds: 300,
				responseContentDisposition:
					"attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
				responseContentType: "application/pdf",
			}),
		).resolves.toBe("https://objects.example/fresh-signature");
		expect(seen).toEqual([
			{
				request: {
					Bucket: "private-artifact-bucket",
					Key: "opaque/run/object",
					ResponseContentDisposition:
						"attachment; filename=\"report.pdf\"; filename*=UTF-8''report.pdf",
					ResponseContentType: "application/pdf",
				},
				expiresInSeconds: 300,
			},
		]);
	});
});
