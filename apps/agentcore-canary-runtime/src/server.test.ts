import { describe, expect, it } from "bun:test";
import type { AgentCoreDispatchIdentity } from "@mymemo/agent-db/canary-dispatch";
import {
	createAcquisitionReceipt,
	serializeCanaryDispatchEnvelope,
} from "agentcore-canary-dispatch/contract";
import { createCanaryRuntime } from "./runtime";
import {
	AGENTCORE_RUNTIME_SESSION_HEADER,
	createRuntimeRequestHandler,
	createRuntimeServerOptions,
} from "./server";

const dispatch: AgentCoreDispatchIdentity = {
	schemaVersion: 2,
	userId: "canary-service-user",
	conversationId: "0198b5a2-0d2b-7b64-9f65-4c9d49045111",
	runId: "run-http-451",
	runtimeSessionId: "0198b5a2-0d2b-7b64-9f65-4c9d49045111",
	admittedAt: new Date("2026-08-14T19:00:00.000Z"),
};

function runtime() {
	let acquisitionCount = 0;
	const result = {
		disposition: "acquired",
		owner: {
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			epoch: 11,
		},
		workerId: "boot-http/invocation-1",
	} as const;
	const receiptLine = `${JSON.stringify(
		createAcquisitionReceipt(
			dispatch,
			result,
			new Date("2026-08-14T19:00:01.000Z"),
		),
	)}\n`;
	return {
		get acquisitionCount() {
			return acquisitionCount;
		},
		receiptLine,
		value: createCanaryRuntime({
			acquire: async () => {
				acquisitionCount++;
				return { dispatch, result, receiptLine };
			},
			serve: async () => ({ type: "terminal", status: "done" }),
			heartbeat: async () => "alive",
			release: async () => {},
			heartbeatIntervalMs: 10,
		}),
	};
}

describe("AgentCore Runtime HTTP contract", () => {
	it("disables Bun's idle timeout for silent in-flight invocation streams", () => {
		const options = createRuntimeServerOptions(runtime().value, 4510);

		expect(options.hostname).toBe("0.0.0.0");
		expect(options.port).toBe(4510);
		expect(options.idleTimeout).toBe(0);
	});

	it("serves /ping and streams the committed receipt from /invocations", async () => {
		const fixture = runtime();
		const handle = createRuntimeRequestHandler(fixture.value);

		const ping = await handle(new Request("http://runtime/ping"));
		expect(ping.status).toBe(200);
		expect(ping.headers.get("content-type")).toContain("application/json");
		expect(await ping.json()).toEqual({ status: "Healthy" });

		const response = await handle(
			new Request("http://runtime/invocations", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[AGENTCORE_RUNTIME_SESSION_HEADER]: dispatch.runtimeSessionId,
				},
				body: serializeCanaryDispatchEnvelope(dispatch),
			}),
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("application/x-ndjson");
		expect(await response.text()).toBe(fixture.receiptLine);
		expect(fixture.acquisitionCount).toBe(1);
	});

	it("rejects a Runtime-session mismatch before Durable acquisition", async () => {
		const fixture = runtime();
		const response = await createRuntimeRequestHandler(fixture.value)(
			new Request("http://runtime/invocations", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[AGENTCORE_RUNTIME_SESSION_HEADER]: "different-session",
				},
				body: serializeCanaryDispatchEnvelope(dispatch),
			}),
		);

		expect(response.status).toBe(400);
		expect(fixture.acquisitionCount).toBe(0);
	});

	it("does not misclassify an internal failure by matching its message", async () => {
		const response = await createRuntimeRequestHandler({
			health: () => ({ status: "Healthy" }),
			invoke: async () => {
				throw new Error("invalid AgentCore dispatch envelope");
			},
		})(
			new Request("http://runtime/invocations", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					[AGENTCORE_RUNTIME_SESSION_HEADER]: dispatch.runtimeSessionId,
				},
				body: serializeCanaryDispatchEnvelope(dispatch),
			}),
		);

		expect(response.status).toBe(503);
	});
});
