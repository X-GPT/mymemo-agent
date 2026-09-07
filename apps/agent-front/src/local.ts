import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app";
import { Artifacts } from "./artifacts";
import { HistoryStore } from "./history";
import { Messages } from "./messages";
import { ConversationStore } from "./store";
import { Workspace } from "./workspace";

// Development-only composition, never imported by the Lambda entry point.
export const localClient = new DynamoDBClient({
	region: "us-west-2",
	endpoint: "http://127.0.0.1:8000",
	credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
export const localTable = "mymemo-conversations";
const store = new ConversationStore(
	DynamoDBDocumentClient.from(localClient),
	localTable,
);
export const localS3 = new S3Client({
	region: "us-west-2",
	endpoint: "http://127.0.0.1:9000",
	forcePathStyle: true,
	credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
});
export const localBucket = "mymemo-history";
const interpreterId = process.env.CODE_INTERPRETER_ID;
if (!interpreterId) throw new Error("CODE_INTERPRETER_ID is required");
const app = createApp(
	store,
	{ isAgentEnabled: async () => true },
	new Messages(
		store,
		new HistoryStore(localS3, localBucket),
		async (input) => {
			const response = await fetch("http://127.0.0.1:8080/invocations", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(input),
			});
			if (!response.ok || !response.body)
				throw new Error("Runtime invocation failed");
			return response.body;
		},
		new Workspace(
			new BedrockAgentCoreClient({}),
			interpreterId,
			localS3,
			localBucket,
		),
		new Artifacts(localS3, localBucket),
	),
);
export default { port: 3000, idleTimeout: 0, fetch: app.fetch };
