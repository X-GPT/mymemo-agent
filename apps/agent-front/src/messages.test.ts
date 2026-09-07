import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import assert from "node:assert/strict";
import {
	DeleteTableCommand,
	DynamoDBClient,
	UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
	CreateBucketCommand,
	DeleteBucketCommand,
	DeleteObjectCommand,
	PutObjectCommand,
	S3Client,
} from "@aws-sdk/client-s3";
import {
	DynamoDBDocumentClient,
	QueryCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app";
import { Artifacts } from "./artifacts";
import { HistoryStore, type Turn } from "./history";
import { Messages } from "./messages";
import type { Invocation } from "./runtime";
import { ConversationStore } from "./store";
import { createTable } from "./table";
import { WorkspaceTooLarge } from "./workspace";

const endpoint = process.env.TEST_DYNAMODB_ENDPOINT;
describe.skipIf(!endpoint)("Turn admission and whole-reply history", () => {
	const credentials = { accessKeyId: "local", secretAccessKey: "local" };
	const client = new DynamoDBClient({
		endpoint,
		region: "us-east-1",
		credentials,
	});
	const db = DynamoDBDocumentClient.from(client);
	const table = `messages-test-${crypto.randomUUID()}`;
	const store = new ConversationStore(db, table);
	const s3Endpoint = process.env.TEST_S3_ENDPOINT;
	const s3 = new S3Client({
		endpoint: s3Endpoint ?? "http://127.0.0.1:9000",
		region: "us-east-1",
		credentials: { accessKeyId: "minioadmin", secretAccessKey: "minioadmin" },
		forcePathStyle: true,
	});
	const bucket = `history-test-${crypto.randomUUID()}`;
	const ids: string[] = [];
	beforeAll(async () => {
		await createTable(client, table);
		if (s3Endpoint) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
	});
	afterAll(async () => {
		if (s3Endpoint) {
			for (const id of ids) await new HistoryStore(s3, bucket).delete(id);
			await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
		}
		await client.send(
			new UpdateTableCommand({
				TableName: table,
				DeletionProtectionEnabled: false,
			}),
		);
		await client.send(new DeleteTableCommand({ TableName: table }));
		client.destroy();
		s3.destroy();
	});
	async function harness(
		fail?: "start" | "restore" | "save" | "stop" | "oversize",
	) {
		const userId = crypto.randomUUID();
		const headers = {
			"x-member-code": userId,
			"x-partner-code": "partner",
			"content-type": "application/json",
		};
		const conversation = await store.create(
			{ memberCode: userId, partnerCode: "partner" },
			{},
		);
		const id = conversation.conversationId;
		ids.push(id);
		const history = new HistoryStore(s3, bucket);
		if (!s3Endpoint) {
			// The same HTTP/transaction tests run in DynamoDB-only environments.
			const turns = new Map<number, Turn>();
			history.put = async (_, turn) => {
				turns.set(turn.seq, structuredClone(turn));
			};
			history.get = async (_, seq) => structuredClone(turns.get(seq));
		}
		const calls: {
			input: Invocation;
			controller: ReadableStreamDefaultController<Uint8Array>;
		}[] = [];
		const lifecycle: string[] = [];
		const operation = async (name: string) => {
			lifecycle.push(name);
			if (name === "save" && fail === "oversize") throw new WorkspaceTooLarge();
			if (name === fail) throw new Error("injected Sandbox failure");
		};
		const artifacts = new Artifacts(s3, bucket);
		spyOn(artifacts, "sync").mockResolvedValue({ artifacts: [], removed: [] });
		const messages = new Messages(
			store,
			history,
			async (input) =>
				new ReadableStream({
					start(controller) {
						calls.push({ input, controller });
					},
				}),
			{
				start: async () => {
					await operation("start");
					return "test-session";
				},
				restore: () => operation("restore"),
				save: () => operation("save"),
				stop: () => operation("stop"),
				call: async () => ({ content: [] }),
				readParts: async () => Buffer.alloc(0),
			},
			artifacts,
		);
		const app = createApp(
			store,
			{ isAgentEnabled: async () => true },
			messages,
		);
		const send = (text = "hello", requestId: string = crypto.randomUUID()) =>
			app.request(`/v1/conversations/${id}/messages`, {
				method: "POST",
				headers,
				body: JSON.stringify({ text, requestId }),
			});
		const page = async (query = "") => {
			const response = await app.request(
				`/v1/conversations/${id}/messages${query}`,
				{ headers },
			);
			expect(response.status).toBe(200);
			return (await response.json()) as {
				messages: Array<Turn["user"] | NonNullable<Turn["assistant"]>>;
				nextCursor: string | null;
			};
		};
		const raw = (index: number, value: unknown) =>
			calls[index]?.controller.enqueue(
				new TextEncoder().encode(`${JSON.stringify(value)}\n`),
			);
		const complete = (index = 0) => {
			for (const event of [
				{ type: "message_start" },
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "text", text: "" },
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "text_delta", text: "reply" },
				},
				{ type: "content_block_stop", index: 0 },
				{ type: "message_stop" },
			])
				raw(index, { type: "stream_event", event });
			raw(index, { type: "result", subtype: "success", is_error: false });
			calls[index]?.controller.close();
		};
		const expire = () =>
			db.send(
				new UpdateCommand({
					TableName: table,
					Key: { PK: `CONV#${id}`, SK: "META" },
					UpdateExpression: "SET processing.#until = :until",
					ExpressionAttributeNames: { "#until": "until" },
					ExpressionAttributeValues: { ":until": "2000-01-01T00:00:00.000Z" },
				}),
			);
		return {
			id,
			artifacts,
			lifecycle,
			userId,
			headers,
			app,
			messages,
			history,
			calls,
			send,
			page,
			raw,
			complete,
			expire,
		};
	}

	test.skipIf(!s3Endpoint)(
		"Downloads and PresentUI arrive on done/error and reload; links work immediately and deletion mirrors",
		async () => {
			const h = await harness();
			const artifact = {
				artifactId: "chart-id",
				path: "chart.png",
				sizeBytes: 3,
				contentType: "image/png",
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			};
			const key = `_artifacts/${h.id}/`;
			const put = (name: string, body: string) =>
				s3.send(
					new PutObjectCommand({ Bucket: bucket, Key: key + name, Body: body }),
				);
			await put("chart.png", "png");
			await put(
				".manifest.json",
				JSON.stringify([{ ...artifact, mtime: "1" }]),
			);
			spyOn(h.artifacts, "sync").mockResolvedValue({
				artifacts: [artifact],
				removed: [],
			});
			const response = await h.send();
			await Bun.sleep(20);
			const payload = {
				component: "table" as const,
				props: { columns: [{ key: "x", label: "X" }], rows: [{ x: 42 }] },
			};
			h.raw(0, {
				type: "assistant",
				message: {
					content: [
						{ type: "tool_use", name: "PresentUI", id: "ui", input: payload },
					],
				},
			});
			h.raw(0, {
				type: "user",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "ui", content: "accepted" },
					],
				},
			});
			h.complete();
			const body = await response.text();
			expect(body.indexOf('"type":"data-artifacts"')).toBeLessThan(
				body.indexOf('"type":"message-metadata"'),
			);
			expect(body).toContain('"type":"data-generative-ui"');
			expect(body).not.toContain('"toolName":"PresentUI"');
			const page = await h.page();
			expect(page.messages[1]?.parts).toContainEqual({
				type: "data-generative-ui",
				id: "ui",
				data: { version: 1, payload },
			});
			const get = (path: string, headers = h.headers) =>
				h.app.request(`/v1/conversations/${h.id}/artifacts${path}`, {
					headers,
				});
			expect(await (await get("")).json()).toEqual({ artifacts: [artifact] });
			const signed = (await (await get("/chart-id/download-url")).json()) as {
				downloadUrl: string;
			};
			const download = await fetch(signed.downloadUrl);
			expect(download.status).toBe(200);
			expect(download.headers.get("content-disposition")).toStartWith(
				"attachment",
			);
			expect(await download.text()).toBe("png");
			expect((await get("/missing/download-url")).status).toBe(404);
			expect(
				(await get("", { ...h.headers, "x-member-code": crypto.randomUUID() }))
					.status,
			).toBe(404);
			await s3.send(
				new DeleteObjectCommand({ Bucket: bucket, Key: `${key}chart.png` }),
			);
			await put(".manifest.json", "[]");
			spyOn(h.artifacts, "sync").mockResolvedValue({
				artifacts: [],
				removed: [artifact.artifactId],
			});
			const second = await h.send("delete");
			await Bun.sleep(20);
			h.raw(1, {
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
			});
			h.calls[1]?.controller.close();
			const errorBody = await second.text();
			expect(errorBody).toContain('"removed":["chart-id"]');
			expect(errorBody.indexOf('"type":"data-artifacts"')).toBeLessThan(
				errorBody.indexOf('"type":"message-metadata"'),
			);
			expect((await get("/chart-id/download-url")).status).toBe(404);
			expect(await (await get("")).json()).toEqual({ artifacts: [] });
			await s3.send(
				new DeleteObjectCommand({
					Bucket: bucket,
					Key: `${key}.manifest.json`,
				}),
			);
		},
	);

	test("Sandbox lifecycle saves only after result and always stops before terminal history", async () => {
		for (const mode of [
			"done",
			"error-result",
			"missing-result",
			"lost",
			"start",
			"restore",
			"save",
			"stop",
			"oversize",
		] as const) {
			const h = await harness(
				["start", "restore", "save", "stop", "oversize"].includes(mode)
					? (mode as "start" | "restore" | "save" | "stop" | "oversize")
					: undefined,
			);
			const response = await h.send();
			// start/restore are asynchronous before the Runtime is invoked.
			for (
				let i = 0;
				i < 100 && !h.calls.length && h.messages.pending.size;
				i++
			)
				await Bun.sleep(1);
			if (h.calls.length) {
				expect(h.calls[0]?.input.sandboxSessionId).toBe("test-session");
				if (mode === "lost")
					h.raw(0, { type: "mymemo.error", code: "internal_error" });
				if (mode === "missing-result" || mode === "lost")
					h.calls[0]?.controller.close();
				else if (mode === "error-result") {
					h.raw(0, {
						type: "result",
						subtype: "error_during_execution",
						is_error: true,
						terminal_reason: "aborted_streaming",
					});
					h.calls[0]?.controller.close();
				} else h.complete();
			}
			const wire = await response.text();
			const saved = await h.history.get(h.id, 1);
			expect(saved?.status).toBe(mode === "done" ? "done" : "error");
			if (mode !== "done")
				expect(saved?.errorCode).toBe(
					mode === "oversize"
						? "workspace_too_large"
						: mode === "error-result"
							? "budget_exceeded"
							: "internal_error",
				);
			expect(h.lifecycle).toEqual(
				mode === "start"
					? ["start"]
					: mode === "restore" || mode === "missing-result" || mode === "lost"
						? ["start", "restore", "stop"]
						: ["start", "restore", "save", "stop"],
			);
			expect(h.artifacts.sync).toHaveBeenCalledTimes(
				["start", "restore", "missing-result", "lost"].includes(mode) ? 0 : 1,
			);
			expect(wire).toContain(
				mode === "done" ? '"type":"finish"' : '"type":"error"',
			);
			expect(await store.get(h.id, h.userId)).not.toHaveProperty("processing");
		}
	});

	test("concurrent sends admit exactly once; request retries distinguish duplicate and conflicting text", async () => {
		const h = await harness();
		const responses = await Promise.all([
			h.send("first", "first"),
			h.send("second", "second"),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		expect(h.calls).toHaveLength(1);
		const winner = h.calls[0]?.input;
		const losing = responses.find((response) => response.status === 409);
		assert(winner && losing);
		expect(await losing.json()).toMatchObject({
			error: "processing",
			turnId: winner.turnId,
		});
		const duplicate = await h.send(winner.text, winner.requestId);
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			error: "duplicate_request",
			turnId: winner.turnId,
			status: "processing",
		});
		expect(
			await (await h.send(`${winner.text} `, winner.requestId)).json(),
		).toEqual({ error: "request_id_conflict" });
		const rows = await db.send(
			new QueryCommand({
				TableName: table,
				KeyConditionExpression: "PK = :pk",
				ExpressionAttributeValues: { ":pk": `CONV#${h.id}` },
				ConsistentRead: true,
			}),
		);
		expect(rows.Items?.filter((row) => row.SK.startsWith("REQ#"))).toHaveLength(
			1,
		);
		expect(await store.get(h.id, h.userId)).toMatchObject({
			turnCount: 1,
			title: winner.text,
			scope: { kind: "general" },
		});
		h.complete();
		await responses.find((response) => response.status === 200)?.text();
		expect(
			await (await h.send(winner.text, winner.requestId)).json(),
		).toMatchObject({ status: "done" });
		expect(h.calls).toHaveLength(1);
	});

	test("simultaneous identical request ids cannot invoke twice", async () => {
		const h = await harness();
		const responses = await Promise.all([
			h.send("same", "same"),
			h.send("same", "same"),
		]);
		expect(responses.map((response) => response.status).sort()).toEqual([
			200, 409,
		]);
		expect(h.calls).toHaveLength(1);
		expect(
			await responses.find((response) => response.status === 409)?.json(),
		).toMatchObject({ error: "duplicate_request", status: "processing" });
		h.complete();
		await responses.find((response) => response.status === 200)?.text();
		expect((await store.get(h.id, h.userId)).turnCount).toBe(1);
	});

	test("reload sees only the processing user message, then exactly the whole streamed reply", async () => {
		const h = await harness();
		const response = await h.send();
		expect(response.headers.get("x-vercel-ai-ui-message-stream")).toBe("v1");
		const initial = await h.page();
		expect(initial.messages).toHaveLength(1);
		expect(initial.messages[0]).toMatchObject({
			role: "user",
			metadata: { status: "processing" },
		});
		h.complete();
		const wire = await response.text();
		expect(wire).toContain("data: [DONE]");
		const chunks = wire
			.split("\n\n")
			.filter((line) => line.startsWith("data: {"))
			.map((line) => JSON.parse(line.slice(6)));
		const ended = await h.page();
		expect(ended.messages).toHaveLength(2);
		const saved = await h.history.get(h.id, 1);
		assert(saved?.assistant);
		expect(ended.messages[1]).toEqual(saved.assistant);
		expect(ended.messages[1]?.id).toBe(chunks[0].messageId);
		expect(ended.messages[1]?.metadata).toEqual(
			chunks.find((chunk) => chunk.type === "message-metadata").messageMetadata,
		);
		expect(await store.get(h.id, h.userId)).not.toHaveProperty("processing");
	});

	test("new admission marks expired work abandoned, pages Turns, and fences late completion", async () => {
		const h = await harness();
		const old = await h.send("old", "old");
		await h.expire();
		const current = await h.send("new", "new");
		expect(current.status).toBe(200);
		expect(h.calls).toHaveLength(2);
		const firstPage = await h.page("?limit=1");
		expect(firstPage.messages[0]?.metadata.requestId).toBe("new");
		expect(firstPage.nextCursor).toBe("2");
		const secondPage = await h.page(`?limit=1&cursor=${firstPage.nextCursor}`);
		expect(secondPage.messages[0]).toMatchObject({
			metadata: { requestId: "old", status: "error", errorCode: "abandoned" },
		});
		expect(secondPage.nextCursor).toBeNull();
		h.complete(0);
		await old.text();
		expect((await store.get(h.id, h.userId)).processing?.turnId).toBe(
			h.calls[1]?.input.turnId,
		);
		h.complete(1);
		await current.text();
		expect(await store.get(h.id, h.userId)).not.toHaveProperty("processing");
	});

	test("disconnect still drains Runtime and persists the completed reply", async () => {
		const h = await harness();
		const persisted = Promise.withResolvers<void>();
		const put = h.history.put.bind(h.history);
		const spy = spyOn(h.history, "put").mockImplementation(async (id, turn) => {
			await put(id, turn);
			if (turn.assistant) persisted.resolve();
		});
		try {
			const response = await h.send();
			await response.body?.cancel();
			h.complete();
			await persisted.promise;
			expect((await h.history.get(h.id, 1))?.assistant?.metadata.status).toBe(
				"done",
			);
		} finally {
			spy.mockRestore();
		}
	});

	test("history persistence failure leaves processing and never emits terminal success", async () => {
		for (const initial of [true, false]) {
			const h = await harness();
			const put = h.history.put.bind(h.history);
			const spy = spyOn(h.history, "put").mockImplementation(
				async (id, turn) => {
					if (initial || turn.assistant) throw new Error("injected S3 failure");
					await put(id, turn);
				},
			);
			try {
				const response = await h.send();
				if (initial) {
					expect(response.status).toBe(500);
					expect(h.calls).toHaveLength(0);
				} else {
					h.complete();
					await expect(response.text()).rejects.toThrow("injected S3 failure");
					expect((await h.history.get(h.id, 1))?.assistant).toBeNull();
				}
				expect((await store.get(h.id, h.userId)).processing).toBeDefined();
			} finally {
				spy.mockRestore();
			}
		}
	});

	test("send gate, strict validation, identity, ownership and archive precede admission", async () => {
		const h = await harness();
		const url = `/v1/conversations/${h.id}/messages`;
		for (const body of [
			{ text: " ", requestId: "r" },
			{ text: "x", requestId: "" },
			{ text: "界".repeat(10923), requestId: "r" },
			{ text: "x", requestId: "r", history: [] },
		]) {
			expect(
				(
					await h.app.request(url, {
						method: "POST",
						headers: h.headers,
						body: JSON.stringify(body),
					})
				).status,
			).toBe(400);
		}
		for (const isAgentEnabled of [
			async () => false,
			async () => {
				throw new Error("gate unavailable");
			},
		]) {
			const app = createApp(store, { isAgentEnabled }, h.messages);
			expect(
				(
					await app.request(url, {
						method: "POST",
						headers: h.headers,
						body: JSON.stringify({ text: "x", requestId: "r" }),
					})
				).status,
			).toBe(403);
		}
		expect(
			(
				await h.app.request(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				})
			).status,
		).toBe(401);
		expect(
			(
				await h.app.request(url, {
					method: "POST",
					headers: { ...h.headers, "x-member-code": crypto.randomUUID() },
					body: "{}",
				})
			).status,
		).toBe(404);
		await store.update(h.id, h.userId, { archived: true });
		expect(await (await h.send()).json()).toEqual({ error: "archived" });
		expect((await store.get(h.id, h.userId)).turnCount).toBe(0);
		expect(h.calls).toHaveLength(0);
	});
});
