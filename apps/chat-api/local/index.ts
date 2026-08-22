import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createLiveStreamTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "../src/app";
import { loadApiConfigFromEnv } from "../src/config/env";
import { createDeps } from "../src/deps";
import { createS3ArtifactDownloadSigner } from "../src/features/artifacts";

const config = loadApiConfigFromEnv({
	...Bun.env,
	STATSIG_SERVER_SECRET: "unused-by-local-composition",
});
const artifactEndpoint = Bun.env.LOCAL_ARTIFACT_ENDPOINT?.trim();
if (!artifactEndpoint) throw new Error("LOCAL_ARTIFACT_ENDPOINT is required");
const artifactClient = new S3Client({
	region: config.artifactRegion,
	endpoint: artifactEndpoint,
	forcePathStyle: true,
});
const logger = pino({ level: config.logLevel });
const deps = createDeps(
	config,
	createLiveStreamTelemetry("chat-api", logger),
	{ isAgentEnabled: async () => true },
	createS3ArtifactDownloadSigner(
		{ bucket: config.artifactBucket, region: config.artifactRegion },
		{
			presignGetObject: (request, expiresInSeconds) =>
				getSignedUrl(artifactClient, new GetObjectCommand(request), {
					expiresIn: expiresInSeconds,
				}),
		},
	),
);
let shuttingDown = false;
async function close(): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	await deps.closeLiveResources().catch(() => {});
	process.exit(0);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

export default createApp(config, deps);
