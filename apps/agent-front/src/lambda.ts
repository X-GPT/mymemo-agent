import type { Writable } from "node:stream";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Statsig } from "@statsig/statsig-node-core";
import { streamHandle } from "hono/aws-lambda";
import { createApp } from "./app";
import { StatsigExposureGate } from "./exposure-gate";
import { HistoryStore } from "./history";
import { Messages } from "./messages";
import { agentCoreRuntime } from "./runtime";
import { ConversationStore } from "./store";
import { Workspace } from "./workspace";

const table = process.env.CONVERSATIONS_TABLE;
const secret = process.env.STATSIG_SERVER_SECRET;
const bucket = process.env.WORKSPACE_BUCKET;
const runtimeArn = process.env.AGENT_RUNTIME_ARN;
const interpreterId = process.env.CODE_INTERPRETER_ID;
if (!table || !secret || !bucket || !runtimeArn || !interpreterId)
	throw new Error(
		"CONVERSATIONS_TABLE, STATSIG_SERVER_SECRET, WORKSPACE_BUCKET, AGENT_RUNTIME_ARN and CODE_INTERPRETER_ID are required",
	);
const store = new ConversationStore(
	DynamoDBDocumentClient.from(new DynamoDBClient({})),
	table,
);
const statsig = new Statsig(secret, { outputLogLevel: "warn" });
const history = new HistoryStore(new S3Client({}), bucket);
const messages = new Messages(
	store,
	history,
	agentCoreRuntime(runtimeArn),
	new Workspace(
		new BedrockAgentCoreClient({}),
		interpreterId,
		history.s3,
		bucket,
	),
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
				await store.sweep((id) => history.delete(id));
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
