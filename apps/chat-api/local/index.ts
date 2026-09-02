import { createLiveStreamTelemetry } from "@mymemo/live-text";
import pino from "pino";
import { createApp } from "../src/app";
import { loadApiConfigFromEnv } from "../src/config/env";
import { loadHarnessConfigFromEnv } from "../src/config/harness-env";
import { createDeps } from "../src/deps";
import aiChatRoutes from "../src/features/ai-chat/ai-chat.route";
import { createHarnessChatAgentFactory } from "../src/features/ai-chat/harness-chat-agent";
import { createS3ArtifactDownloadSigner } from "../src/features/artifacts/s3-artifact-download-signer";

const config = loadApiConfigFromEnv({
	...Bun.env,
	STATSIG_SERVER_SECRET: "unused-by-local-composition",
});
const artifactEndpoint = Bun.env.LOCAL_ARTIFACT_ENDPOINT?.trim();
const logger = pino({ level: config.logLevel });
const deps = createDeps(
	config,
	createHarnessChatAgentFactory(loadHarnessConfigFromEnv(Bun.env)),
	createLiveStreamTelemetry("chat-api", logger),
	{ isAgentEnabled: async () => true },
	createS3ArtifactDownloadSigner(
		{ bucket: config.artifactBucket, region: config.artifactRegion },
		{ endpoint: artifactEndpoint },
	),
);
// Local only: `IN_VM_SERVER_URL` names one hand-started In-VM server
// (apps/in-vm-server on the same Postgres + Redis) to nudge instead of
// orchestrating a MicroVM. Production composition has no such seam.
const inVmServerUrl = Bun.env.IN_VM_SERVER_URL?.trim();
if (inVmServerUrl) {
	deps.ensureVm = async (_ref, _logger, command) => {
		const response = await fetch(new URL("/nudge", inVmServerUrl), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: command ? JSON.stringify(command) : undefined,
			signal: AbortSignal.timeout(5_000),
		});
		if (!response.ok) {
			logger.warn(
				{ status: response.status },
				"local In-VM server nudge failed",
			);
		}
	};
}

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
app.route("/api/chat", aiChatRoutes);

export default app;
