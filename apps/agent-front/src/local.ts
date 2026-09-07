import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app";
import { HistoryStore } from "./history";
import { Messages } from "./messages";
import { ConversationStore } from "./store";

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
const app = createApp(
	store,
	{ isAgentEnabled: async () => true },
	new Messages(store, new HistoryStore(localS3, localBucket), async (input) => {
		const response = await fetch("http://127.0.0.1:8080/invocations", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(input),
		});
		if (!response.ok || !response.body)
			throw new Error("Runtime invocation failed");
		return response.body;
	}),
);
export default { port: 3000, idleTimeout: 0, fetch: app.fetch };
