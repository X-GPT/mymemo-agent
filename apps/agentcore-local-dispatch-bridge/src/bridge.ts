import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/agentcore-dispatch";
import type { Database } from "@mymemo/agent-db/client";
import { createDatabaseAgentCoreDispatchPublisherStore } from "@mymemo/agentcore-dispatch/database-store";
import { serializeAgentCoreDispatchEnvelope } from "@mymemo/agentcore-dispatch/envelope";
import { createAgentCoreDispatchPublisher } from "@mymemo/agentcore-dispatch/publisher";
import {
	type AgentCoreRuntimeInvocation,
	createAgentCoreDispatchConsumer,
} from "agentcore-dispatch-consumer/consumer";

const RUNTIME_SESSION_HEADER = "x-amzn-bedrock-agentcore-runtime-session-id";

type Fetch = (request: Request) => Promise<Response>;

function createLocalRuntimeInvoker(options: {
	runtimeUrl: string;
	invocationTimeoutMs: number;
	fetch: Fetch;
}) {
	return {
		async invoke(
			dispatch: AgentCoreDispatchIdentity,
		): Promise<AgentCoreRuntimeInvocation> {
			const response = await options.fetch(
				new Request(`${options.runtimeUrl.replace(/\/+$/, "")}/invocations`, {
					method: "POST",
					headers: {
						"content-type": "application/json",
						[RUNTIME_SESSION_HEADER]: dispatch.runtimeSessionId,
					},
					body: serializeAgentCoreDispatchEnvelope(dispatch),
					signal: AbortSignal.timeout(options.invocationTimeoutMs),
				}),
			);
			if (!response.ok) {
				await response.body?.cancel().catch(() => {});
				throw new Error(`local AgentCore Runtime returned ${response.status}`);
			}
			if (
				!response.headers
					.get("content-type")
					?.startsWith("application/x-ndjson") ||
				!response.body
			) {
				await response.body?.cancel().catch(() => {});
				throw new Error("local AgentCore Runtime returned an invalid response");
			}
			return {
				chunks: response.body,
				close: () => response.body?.cancel(),
			};
		},
	};
}

/** Development-only bridge from the durable outbox to a local Runtime. */
export function createLocalAgentCoreDispatchBridge(options: {
	db: Database;
	publisherId: string;
	runtimeUrl: string;
	invocationTimeoutMs?: number;
	fetch?: Fetch;
	now?: () => Date;
}) {
	const control = { isEnabled: async () => true };
	const consumer = createAgentCoreDispatchConsumer({
		control,
		loadRunStatus: async () => null,
		runtime: createLocalRuntimeInvoker({
			runtimeUrl: options.runtimeUrl,
			invocationTimeoutMs: options.invocationTimeoutMs ?? 30_000,
			fetch: options.fetch ?? fetch,
		}),
		alarm: { raise: async () => {} },
	});
	const publisher = createAgentCoreDispatchPublisher({
		publisherId: options.publisherId,
		control,
		store: createDatabaseAgentCoreDispatchPublisherStore({
			db: options.db,
			now: options.now,
		}),
		queue: {
			async send(dispatch) {
				const response = await consumer.handle({
					Records: [
						{
							messageId: dispatch.runId,
							body: serializeAgentCoreDispatchEnvelope(dispatch),
						},
					],
				});
				if (response.batchItemFailures.length > 0) {
					throw new Error("local AgentCore Dispatch remains retryable");
				}
			},
		},
	});

	return { pollOnce: () => publisher.publishPending() };
}
