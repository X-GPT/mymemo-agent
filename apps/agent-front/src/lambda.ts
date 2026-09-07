import type { Writable } from "node:stream";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import {
	GetSecretValueCommand,
	SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Statsig } from "@statsig/statsig-node-core";
import { streamHandle } from "hono/aws-lambda";
import { createApp } from "./app";
import { Artifacts } from "./artifacts";
import { deleteConversationObjects } from "./cleanup";
import { StatsigExposureGate } from "./exposure-gate";
import { HistoryStore } from "./history";
import { Messages } from "./messages";
import { agentCoreRuntime } from "./runtime";
import { ConversationStore } from "./store";
import { Workspace } from "./workspace";

const table = process.env.CONVERSATION_TABLE;
const secretArn = process.env.STATSIG_SERVER_SECRET_ARN;
const bucket = process.env.WORKSPACE_BUCKET;
const runtimeArn = process.env.AGENT_RUNTIME_ARN;
const interpreterId = process.env.CODE_INTERPRETER_ID;
if (!table || !secretArn || !bucket || !runtimeArn || !interpreterId)
	throw new Error(
		"CONVERSATION_TABLE, STATSIG_SERVER_SECRET_ARN, WORKSPACE_BUCKET, AGENT_RUNTIME_ARN and CODE_INTERPRETER_ID are required",
	);
const { SecretString: secret } = await new SecretsManagerClient({}).send(
	new GetSecretValueCommand({
		SecretId: secretArn,
		VersionStage: "AWSCURRENT",
	}),
);
if (!secret) throw new Error("Statsig secret must be a nonempty string");
const s3 = new S3Client({});
const store = new ConversationStore(
	DynamoDBDocumentClient.from(new DynamoDBClient({})),
	table,
);
const statsig = new Statsig(secret, { outputLogLevel: "warn" });
const history = new HistoryStore(s3, bucket);
const messages = new Messages(
	store,
	history,
	agentCoreRuntime(runtimeArn),
	new Workspace(new BedrockAgentCoreClient({}), interpreterId, s3, bucket),
	new Artifacts(s3, bucket),
);
const app = createApp(store, new StatsigExposureGate(statsig), messages);
type StreamingHandler = (
	event: Record<string, unknown>,
	stream: Writable,
	context: unknown,
) => Promise<void>;
declare const awslambda: {
	streamifyResponse(handler: StreamingHandler): StreamingHandler;
};
// Hono's declaration describes a buffered handler; streamHandle actually takes
// (event, responseStream, context), as required by the Lambda streaming runtime.
const httpHandler = streamHandle(app) as unknown as StreamingHandler;
export const handler = awslambda.streamifyResponse(
	async (event, stream, context) => {
		try {
			// Scheduler supplies this payload directly; HTTP bodies cannot select it.
			if (event.source === "mymemo.cleanup" && !("requestContext" in event)) {
				await store.sweep((id) => deleteConversationObjects(s3, bucket, id));
				stream.end();
			} else {
				await httpHandler(event, stream, context);
			}
		} finally {
			// A disconnected HTTP writer must not freeze the Lambda before the Turn is saved.
			await Promise.all(messages.pending);
			await statsig.flushEvents().catch(() => undefined);
		}
	},
);
