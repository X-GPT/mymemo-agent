import type { Writable } from "node:stream";
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
import { deleteConversationObjects } from "./cleanup";
import { StatsigExposureGate } from "./exposure-gate";
import { ConversationStore } from "./store";

const table = process.env.CONVERSATION_TABLE;
const secretArn = process.env.STATSIG_SERVER_SECRET_ARN;
const bucket = process.env.WORKSPACE_BUCKET;
if (!table || !secretArn || !bucket)
	throw new Error(
		"CONVERSATION_TABLE, STATSIG_SERVER_SECRET_ARN and WORKSPACE_BUCKET are required",
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
const app = createApp(store, new StatsigExposureGate(statsig));
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
			await statsig.flushEvents().catch(() => undefined);
		}
	},
);
