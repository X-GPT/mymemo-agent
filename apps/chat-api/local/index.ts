import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { createLiveStreamTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "../src/app";
import { loadApiConfigFromEnv } from "../src/config/env";
import { createDeps } from "../src/deps";
import { createBedrockAgentQueryRuntimeInvoker } from "../src/features/ai-chat/agent-query-runtime-invoker";
import { createAiChatRoutes } from "../src/features/ai-chat/ai-chat.route";
import { createAiChatResumableStreams } from "../src/features/ai-chat/resumable-streams";
import { createS3ArtifactDownloadSigner } from "../src/features/artifacts/s3-artifact-download-signer";

const config = loadApiConfigFromEnv({
	...Bun.env,
	STATSIG_SERVER_SECRET: "unused-by-local-composition",
});
const artifactEndpoint = Bun.env.LOCAL_ARTIFACT_ENDPOINT?.trim();
const logger = pino({ level: config.logLevel });
const deps = createDeps(
	config,
	createLiveStreamTelemetry("chat-api", logger),
	{ isAgentEnabled: async () => true },
	createS3ArtifactDownloadSigner(
		{ bucket: config.artifactBucket, region: config.artifactRegion },
		{ endpoint: artifactEndpoint },
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

const app = createApp(config, deps);
const agentQueryRuntimeArn = Bun.env.AGENT_QUERY_RUNTIME_ARN?.trim();
if (agentQueryRuntimeArn) {
	app.route(
		"/api/chat",
		createAiChatRoutes({
			messageStore: deps.chatMessageStore,
			exposureGate: deps.exposureGate,
			resumableStreams: createAiChatResumableStreams(),
			runtimeInvoker: createBedrockAgentQueryRuntimeInvoker({
				client: new BedrockAgentCoreClient({ region: config.artifactRegion }),
				agentRuntimeArn: agentQueryRuntimeArn,
			}),
		}),
	);
}

export default app;
