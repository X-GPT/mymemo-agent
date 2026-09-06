import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app";
import { ConversationStore } from "./store";

// Development-only composition, never imported by the Lambda entry point.
export const localClient = new DynamoDBClient({
	region: "us-west-2",
	endpoint: "http://127.0.0.1:8000",
	credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
export const localTable = "mymemo-conversations";
const app = createApp(
	new ConversationStore(DynamoDBDocumentClient.from(localClient), localTable),
	{ isAgentEnabled: async () => true },
);
export default { port: 3000, fetch: app.fetch };
