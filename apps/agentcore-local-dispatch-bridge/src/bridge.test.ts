import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { recordAgentCoreDispatchInTx } from "@mymemo/agent-db/agentcore-dispatch";
import { admitQueuedRunInTx } from "@mymemo/agent-db/run-store";
import {
	agentCoreDispatchOutbox,
	conversations,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { createAcquisitionReceipt } from "agentcore-dispatch-consumer/contract";
import { createLocalAgentCoreDispatchBridge } from "./bridge";

let tdb: TestDb;

const admittedAt = new Date("2026-08-21T12:00:00.000Z");
const dispatch = {
	schemaVersion: 2 as const,
	userId: "local-user",
	conversationId: "0198c9f6-cf40-7de1-9cb6-5cb7a57b5101",
	runId: "0198c9f6-daf0-74cd-8d13-0c60c25df102",
	runtimeSessionId: "0198c9f6-cf40-7de1-9cb6-5cb7a57b5101",
	admittedAt,
};
const acquiredReceipt = createAcquisitionReceipt(dispatch, {
	disposition: "acquired",
	owner: {
		userId: dispatch.userId,
		conversationId: dispatch.conversationId,
		epoch: 1,
	},
	workerId: "local-runtime/1",
});

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(agentCoreDispatchOutbox);
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: dispatch.userId,
		conversationId: dispatch.conversationId,
		scope: "general",
	});
	await tdb.db.transaction(async (tx) => {
		await admitQueuedRunInTx(tx, {
			runId: dispatch.runId,
			userId: dispatch.userId,
			conversationId: dispatch.conversationId,
			messageId: "0198c9f6-e490-77dd-b72e-a85079c08103",
			text: "Complete one local AgentCore Run.",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
		await recordAgentCoreDispatchInTx(tx, dispatch);
	});
});

describe("local AgentCore Dispatch bridge", () => {
	it("acknowledges a real outbox row after a correlated Acquisition receipt", async () => {
		const requests: Request[] = [];
		const bridge = createLocalAgentCoreDispatchBridge({
			db: tdb.db,
			publisherId: "local-bridge",
			runtimeUrl: "http://runtime:8080",
			fetch: async (request) => {
				requests.push(request);
				return new Response(`${JSON.stringify(acquiredReceipt)}\n`, {
					headers: { "content-type": "application/x-ndjson" },
				});
			},
			now: () => new Date("2026-08-21T12:01:00.000Z"),
		});

		await expect(bridge.pollOnce()).resolves.toEqual({
			status: "enabled",
			publishedRunIds: [dispatch.runId],
			ambiguousRunIds: [],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("http://runtime:8080/invocations");
		expect(
			requests[0]?.headers.get("x-amzn-bedrock-agentcore-runtime-session-id"),
		).toBe(dispatch.runtimeSessionId);
		expect(await requests[0]?.json()).toMatchObject({
			runId: dispatch.runId,
			runtimeSessionId: dispatch.runtimeSessionId,
		});

		const [outbox] = await tdb.db.select().from(agentCoreDispatchOutbox);
		expect(outbox?.publishedAt).toEqual(new Date("2026-08-21T12:01:00.000Z"));
	});

	it.each([
		{
			name: "invocation failure",
			respond: async (_request: Request) => {
				throw new Error("Runtime unavailable");
			},
		},
		{
			name: "timeout",
			respond: async (request: Request) =>
				await new Promise<Response>((_resolve, reject) => {
					request.signal.addEventListener("abort", () => {
						reject(request.signal.reason);
					});
				}),
		},
		{
			name: "invalid response",
			respond: async (_request: Request) => Response.json({ ok: true }),
		},
		{
			name: "missing receipt",
			respond: async (_request: Request) =>
				new Response("", {
					headers: { "content-type": "application/x-ndjson" },
				}),
		},
	])("leaves the Dispatch retryable after $name", async ({ respond }) => {
		let now = new Date("2026-08-21T12:01:00.000Z");
		let failing = true;
		const bridge = createLocalAgentCoreDispatchBridge({
			db: tdb.db,
			publisherId: "local-bridge",
			runtimeUrl: "http://runtime:8080",
			invocationTimeoutMs: 5,
			fetch: async (request) => {
				if (failing) return await respond(request);
				return new Response(`${JSON.stringify(acquiredReceipt)}\n`, {
					headers: { "content-type": "application/x-ndjson" },
				});
			},
			now: () => now,
		});

		await expect(bridge.pollOnce()).resolves.toMatchObject({
			publishedRunIds: [],
			ambiguousRunIds: [dispatch.runId],
		});
		let [outbox] = await tdb.db.select().from(agentCoreDispatchOutbox);
		expect(outbox?.publishedAt).toBeNull();

		failing = false;
		now = new Date("2026-08-21T12:05:00.000Z");
		await expect(bridge.pollOnce()).resolves.toMatchObject({
			publishedRunIds: [dispatch.runId],
			ambiguousRunIds: [],
		});
		[outbox] = await tdb.db.select().from(agentCoreDispatchOutbox);
		expect(outbox?.publishedAt).toEqual(now);
	});

	it("does not acknowledge a receipt correlated to another Dispatch", async () => {
		let now = new Date("2026-08-21T12:01:00.000Z");
		let mismatched = true;
		const bridge = createLocalAgentCoreDispatchBridge({
			db: tdb.db,
			publisherId: "local-bridge",
			runtimeUrl: "http://runtime:8080",
			fetch: async () =>
				new Response(
					`${JSON.stringify(mismatched ? { ...acquiredReceipt, runId: "another-run" } : acquiredReceipt)}\n`,
					{ headers: { "content-type": "application/x-ndjson" } },
				),
			now: () => now,
		});

		await expect(bridge.pollOnce()).resolves.toMatchObject({
			publishedRunIds: [],
			ambiguousRunIds: [dispatch.runId],
		});
		expect(
			(await tdb.db.select().from(agentCoreDispatchOutbox))[0]?.publishedAt,
		).toBeNull();

		mismatched = false;
		now = new Date("2026-08-21T12:05:00.000Z");
		await expect(bridge.pollOnce()).resolves.toMatchObject({
			publishedRunIds: [dispatch.runId],
		});
	});

	it("observes a correlated Runtime receipt even when the Run is terminal", async () => {
		await tdb.db.update(runs).set({ status: "done" });
		let invoked = false;
		const receipt = createAcquisitionReceipt(dispatch, {
			disposition: "terminal",
			status: "done",
		});
		const bridge = createLocalAgentCoreDispatchBridge({
			db: tdb.db,
			publisherId: "local-bridge",
			runtimeUrl: "http://runtime:8080",
			fetch: async () => {
				invoked = true;
				return new Response(`${JSON.stringify(receipt)}\n`, {
					headers: { "content-type": "application/x-ndjson" },
				});
			},
			now: () => new Date("2026-08-21T12:01:00.000Z"),
		});

		await expect(bridge.pollOnce()).resolves.toMatchObject({
			publishedRunIds: [dispatch.runId],
		});
		expect(invoked).toBe(true);
	});
});
