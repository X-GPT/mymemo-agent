import type { Writable } from "node:stream";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { Statsig } from "@statsig/statsig-node-core";
import { streamHandle } from "hono/aws-lambda";
import { createApp } from "./app";
import { StatsigExposureGate } from "./exposure-gate";
import { ConversationStore } from "./store";

const table = process.env.CONVERSATIONS_TABLE;
const secret = process.env.STATSIG_SERVER_SECRET;
if (!table || !secret)
	throw new Error("CONVERSATIONS_TABLE and STATSIG_SERVER_SECRET are required");
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
				await store.sweep();
				stream.end();
			} else {
				await httpHandler(event, stream, context);
			}
		} finally {
			await statsig.flushEvents().catch(() => undefined);
		}
	},
);
