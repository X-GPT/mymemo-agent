import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import {
	DeleteTableCommand,
	DynamoDBClient,
	UpdateTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
	DeleteCommand,
	DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { createApp } from "./app";
import { type ConversationSummary, SendBody } from "./schema";
import { ConversationStore } from "./store";
import { createTable } from "./table";

const endpoint = process.env.TEST_DYNAMODB_ENDPOINT;
describe.skipIf(!endpoint)("Conversation lifecycle with DynamoDB Local", () => {
	const client = new DynamoDBClient({
		endpoint,
		region: "us-east-1",
		credentials: { accessKeyId: "local", secretAccessKey: "local" },
	});
	const db = DynamoDBDocumentClient.from(client);
	const table = `front-test-${crypto.randomUUID()}`;
	const store = new ConversationStore(db, table);
	const app = createApp(store, { isAgentEnabled: async () => true });
	const headers = (member = crypto.randomUUID()) => ({
		"x-member-code": member,
		"x-partner-code": "partner",
		"Content-Type": "application/json",
	});
	const meta = async (id: string) =>
		(
			await db.send(
				new GetCommand({
					TableName: table,
					Key: { PK: `CONV#${id}`, SK: "META" },
					ConsistentRead: true,
				}),
			)
		).Item;
	const create = async (identity: ReturnType<typeof headers>, body = {}) => {
		const response = await app.request("/v1/conversations", {
			method: "POST",
			headers: identity,
			body: JSON.stringify(body),
		});
		expect(response.status).toBe(201);
		return (await response.json()) as ConversationSummary;
	};
	const patch = (
		id: string,
		identity: ReturnType<typeof headers>,
		body: unknown,
	) =>
		app.request(`/v1/conversations/${id}`, {
			method: "PATCH",
			headers: identity,
			body: JSON.stringify(body),
		});
	const list = async (identity: ReturnType<typeof headers>, query = "") => {
		const response = await app.request(`/v1/conversations${query}`, {
			headers: identity,
		});
		expect(response.status).toBe(200);
		return (await response.json()) as {
			conversations: ConversationSummary[];
			nextCursor: string | null;
		};
	};
	beforeAll(async () => {
		await createTable(client, table);
	});
	afterAll(async () => {
		await client.send(
			new UpdateTableCommand({
				TableName: table,
				DeletionProtectionEnabled: false,
			}),
		);
		await client.send(new DeleteTableCommand({ TableName: table }));
		client.destroy();
	});

	test("create copies identity, freezes scope with document precedence, and returns only Summary fields", async () => {
		const identity = {
			...headers(),
			"x-team-code": "team",
			"x-member-name": "ignored",
		};
		for (const [body, scope] of [
			[{}, { kind: "general" }],
			[{ collectionId: "  ", summaryId: null }, { kind: "general" }],
			[
				{ collectionId: " collection " },
				{ kind: "collection", collectionId: "collection" },
			],
			[
				{ collectionId: "collection", summaryId: " document " },
				{ kind: "document", summaryId: "document" },
			],
		] as const) {
			const summary = await create(identity, body);
			expect(summary).toEqual({
				conversationId: expect.any(String),
				title: null,
				scope: scope.kind,
				createdAt: expect.any(String),
				lastActivityAt: expect.any(String),
				archivedAt: null,
			});
			expect(summary.createdAt).toBe(summary.lastActivityAt);
			expect(await meta(summary.conversationId)).toMatchObject({
				userId: identity["x-member-code"],
				partnerCode: "partner",
				teamCode: "team",
				scope,
				turnCount: 0,
			});
			expect(
				(await patch(summary.conversationId, identity, { summaryId: "other" }))
					.status,
			).toBe(400);
		}
	});

	test("identity is required and disabled or unavailable exposure gates fail closed", async () => {
		const missingHeaders: Record<string, string>[] = [
			{},
			{ "x-member-code": "member" },
			{ "x-partner-code": "partner" },
			{ ...headers(), "x-member-code": "x".repeat(257) },
		];
		for (const identity of missingHeaders) {
			const response = await app.request("/v1/conversations", {
				method: "POST",
				headers: { ...identity, "Content-Type": "application/json" },
				body: "{}",
			});
			expect(response.status).toBe(401);
			expect(await response.json()).toHaveProperty("error");
		}
		const identity = headers();
		const summary = await create(identity);
		for (const isAgentEnabled of [
			async () => false,
			async () => {
				throw new Error("unreachable");
			},
		]) {
			const closed = createApp(store, { isAgentEnabled });
			const response = await closed.request("/v1/conversations", {
				method: "POST",
				headers: identity,
				body: "{}",
			});
			expect(response.status).toBe(403);
			expect(await response.json()).toHaveProperty("error");
			expect(
				(await closed.request("/v1/conversations", { headers: identity }))
					.status,
			).toBe(200);
			expect(
				(
					await closed.request(`/v1/conversations/${summary.conversationId}`, {
						method: "PATCH",
						headers: identity,
						body: '{"title":"still accessible"}',
					})
				).status,
			).toBe(200);
		}
	});

	test("strict patch renames and archive changes preserve activity and scope", async () => {
		const identity = headers();
		const summary = await create(identity, { collectionId: "collection" });
		for (const body of [
			{},
			{ title: "" },
			{ title: " " },
			{ title: "x".repeat(257) },
			{ title: "x", archived: true },
			{ archived: "true" },
			{ archived: true, extra: 1 },
			{ title: null },
		]) {
			expect((await patch(summary.conversationId, identity, body)).status).toBe(
				400,
			);
		}
		for (const title of [" Initial title ", "Replacement"]) {
			const response = await patch(summary.conversationId, identity, { title });
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({
				...summary,
				title: title.trim(),
			});
		}
		const archived = (await (
			await patch(summary.conversationId, identity, { archived: true })
		).json()) as ConversationSummary;
		expect(archived).toMatchObject({
			title: "Replacement",
			lastActivityAt: summary.lastActivityAt,
			scope: "collection",
			archivedAt: expect.any(String),
		});
		expect((await list(identity)).conversations).toEqual([]);
		expect((await list(identity, "?archived=true")).conversations).toEqual([
			archived,
		]);
		expect(
			await (
				await patch(summary.conversationId, identity, { archived: true })
			).json(),
		).toEqual(archived);
		const restored = (await (
			await patch(summary.conversationId, identity, { archived: false })
		).json()) as ConversationSummary;
		expect(restored).toEqual({ ...summary, title: "Replacement" });
		expect((await list(identity, "?archived=true")).conversations).toEqual([]);
		expect((await list(identity)).conversations).toEqual([restored]);
		expect((await meta(summary.conversationId))?.scope).toEqual({
			kind: "collection",
			collectionId: "collection",
		});
	});

	test("listing uses descending activity, fills substring search pages, and binds cursors to filters and owner", async () => {
		const identity = headers();
		const ids: string[] = [];
		for (const [index, title] of [
			"needle first",
			"other",
			"NEEDLE second",
			"unmatched",
			"Needle third",
		].entries()) {
			const item = await create(identity);
			ids.push(item.conversationId);
			await patch(item.conversationId, identity, { title });
			const activity = `2026-01-0${index + 1}T00:00:00.000Z`;
			await db.send(
				new UpdateCommand({
					TableName: table,
					Key: { PK: `CONV#${item.conversationId}`, SK: "META" },
					UpdateExpression: "SET lastActivityAt = :activity, GSI1SK = :sort",
					ExpressionAttributeValues: {
						":activity": activity,
						":sort": `${activity}#${item.conversationId}`,
					},
				}),
			);
		}
		expect(
			(await list(identity)).conversations.map((item) => item.conversationId),
		).toEqual(ids.toReversed());
		const first = await list(identity, "?search=needle&limit=2");
		expect(first.conversations.map((item) => item.conversationId)).toEqual(
			ids.filter((_, index) => index === 2 || index === 4).toReversed(),
		);
		expect(first.nextCursor).toBeString();
		const next = await list(
			identity,
			`?search=needle&limit=2&cursor=${first.nextCursor}`,
		);
		expect(next.conversations.map((item) => item.conversationId)).toEqual(
			ids.slice(0, 1),
		);
		expect(next.nextCursor).toBeNull();
		for (const [requestHeaders, query] of [
			[identity, `search=other&cursor=${first.nextCursor}`],
			[identity, `archived=true&search=needle&cursor=${first.nextCursor}`],
			[headers(), `search=needle&cursor=${first.nextCursor}`],
			[identity, "cursor=not-a-cursor"],
			[identity, "limit=0"],
			[identity, "limit=101"],
			[identity, "limit=1.5"],
			[identity, "unknown=true"],
		] as const) {
			const response = await app.request(`/v1/conversations?${query}`, {
				headers: requestHeaders,
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toHaveProperty("error");
		}
	});

	test("foreign, missing and tombstoned IDs return the same 404 before validation on all ID routes", async () => {
		const identity = headers();
		const owned = await create(identity);
		expect(
			await (
				await app.request(
					`/v1/conversations/${owned.conversationId}/messages`,
					{ headers: identity },
				)
			).json(),
		).toEqual({ messages: [], nextCursor: null });
		const foreign = await create(headers());
		const removed = await create(identity);
		expect(
			(
				await app.request(`/v1/conversations/${removed.conversationId}`, {
					method: "DELETE",
					headers: identity,
				})
			).status,
		).toBe(204);
		for (const id of [
			foreign.conversationId,
			crypto.randomUUID(),
			removed.conversationId,
		]) {
			for (const [method, suffix, body] of [
				["PATCH", "", "{}"],
				["DELETE", "", undefined],
				["GET", "/messages?limit=invalid", undefined],
				["GET", "/artifacts", undefined],
				["GET", "/artifacts/missing/download-url", undefined],
				["GET", "/artifacts/missing/content", undefined],
				["POST", "/messages", "{}"],
			] as const) {
				const response = await app.request(`/v1/conversations/${id}${suffix}`, {
					method,
					headers: identity,
					body,
				});
				expect(response.status).toBe(404);
				expect(await response.json()).toEqual({
					error: "Conversation not found",
				});
			}
		}
		expect(
			(await list(identity)).conversations.map((item) => item.conversationId),
		).toEqual([owned.conversationId]);
		expect(await meta(removed.conversationId)).toMatchObject({
			deletedAt: expect.any(String),
			GSI2PK: "CLEANUP",
		});
		expect(await meta(removed.conversationId)).not.toHaveProperty("GSI1PK");
	});

	test("stale listing projections cannot expose a tombstone", async () => {
		const identity = headers();
		const item = await create(identity);
		const projection = await meta(item.conversationId);
		await store.delete(item.conversationId, identity["x-member-code"]);
		const send = db.send.bind(db);
		const spy = spyOn(db, "send").mockImplementation(async (command) => {
			if (
				command instanceof QueryCommand &&
				command.input.IndexName === "GSI1"
			) {
				return { Items: [projection] };
			}
			return send(command);
		});
		try {
			expect((await list(identity)).conversations).toEqual([]);
		} finally {
			spy.mockRestore();
		}
	});

	test("active processing blocks deletion while an expired processing marker does not", async () => {
		const identity = headers();
		const item = await create(identity);
		const mark = (until: string) =>
			db.send(
				new UpdateCommand({
					TableName: table,
					Key: { PK: `CONV#${item.conversationId}`, SK: "META" },
					UpdateExpression: "SET processing = :processing",
					ExpressionAttributeValues: {
						":processing": { turnId: "turn-123", seq: 1, until },
					},
				}),
			);
		await mark("2999-01-01T00:00:00.000Z");
		expect(
			(await patch(item.conversationId, identity, { archived: true })).status,
		).toBe(200);
		const response = await app.request(
			`/v1/conversations/${item.conversationId}`,
			{ method: "DELETE", headers: identity },
		);
		expect(response.status).toBe(409);
		expect(await response.json()).toEqual({
			error: "processing",
			turnId: "turn-123",
		});
		expect(await meta(item.conversationId)).not.toHaveProperty("deletedAt");
		await mark("2000-01-01T00:00:00.000Z");
		expect(
			(
				await app.request(`/v1/conversations/${item.conversationId}`, {
					method: "DELETE",
					headers: identity,
				})
			).status,
		).toBe(204);
	});

	test("concurrent Turn admission and deletion cannot both win their conditioned writes", async () => {
		const identity = headers();
		const item = await create(identity);
		const results = await Promise.allSettled([
			store.delete(item.conversationId, identity["x-member-code"]),
			db.send(
				new UpdateCommand({
					TableName: table,
					Key: { PK: `CONV#${item.conversationId}`, SK: "META" },
					ConditionExpression:
						"attribute_exists(PK) AND attribute_not_exists(deletedAt) AND attribute_not_exists(processing)",
					UpdateExpression: "SET processing = :processing",
					ExpressionAttributeValues: {
						":processing": {
							turnId: "racing-turn",
							seq: 1,
							until: "2999-01-01T00:00:00.000Z",
						},
					},
				}),
			),
		]);
		expect(
			results.filter((result) => result.status === "fulfilled"),
		).toHaveLength(1);
		const state = await meta(item.conversationId);
		expect(Boolean(state?.deletedAt)).not.toBe(Boolean(state?.processing));
	});

	test("cleanup keeps tombstones through failures, retries request deletion, and clears META last", async () => {
		const identity = headers();
		const item = await create(identity);
		const PK = `CONV#${item.conversationId}`;
		for (const SK of ["REQ#first", "REQ#second"])
			await db.send(
				new PutCommand({
					TableName: table,
					Item: { PK, SK, response: "cached" },
				}),
			);
		await store.delete(item.conversationId, identity["x-member-code"]);
		const send = db.send.bind(db);
		const deleted: string[] = [];
		let fail = true;
		const spy = spyOn(db, "send").mockImplementation(async (command) => {
			if (command instanceof DeleteCommand && command.input.Key?.PK === PK) {
				const SK = command.input.Key.SK as string;
				if (SK === "REQ#second" && fail)
					throw new Error("injected delete failure");
				deleted.push(SK);
			}
			return send(command);
		});
		try {
			await expect(store.sweep()).rejects.toThrow("injected delete failure");
			expect(await meta(item.conversationId)).toHaveProperty("deletedAt");
			expect(deleted).toEqual(["REQ#first"]);
			fail = false;
			await store.sweep();
			expect(deleted).toEqual(["REQ#first", "REQ#second", "META"]);
			expect(
				(
					await db.send(
						new QueryCommand({
							TableName: table,
							KeyConditionExpression: "PK = :pk",
							ExpressionAttributeValues: { ":pk": PK },
							ConsistentRead: true,
						}),
					)
				).Items,
			).toEqual([]);
			await store.sweep();
		} finally {
			spy.mockRestore();
		}
	});
});

test("send body carries an optional Turn model and budget and stays strict", () => {
	const base = { text: "hello", requestId: "request" };
	expect(SendBody.safeParse(base).success).toBe(true);
	expect(
		SendBody.parse({
			...base,
			model: "anthropic/claude-sonnet-5",
			maxBudgetUsd: 4,
		}),
	).toEqual({
		...base,
		model: "anthropic/claude-sonnet-5",
		maxBudgetUsd: 4,
	});
	for (const model of [
		"a",
		"9",
		"deepseek/deepseek-v4-flash",
		"openai/gpt-4.1-mini",
		"bedrock:anthropic.claude-3",
		"a".repeat(200),
	])
		expect(SendBody.safeParse({ ...base, model }).success).toBe(true);
	for (const model of [
		"",
		"-leading-dash",
		"/leading-slash",
		".leading-dot",
		"Anthropic/Claude",
		"has space",
		"emoji😀",
		"a".repeat(201),
		42,
		null,
	])
		expect(SendBody.safeParse({ ...base, model }).success).toBe(false);
	for (const maxBudgetUsd of [0.01, 1, 4.32, 10000])
		expect(SendBody.safeParse({ ...base, maxBudgetUsd }).success).toBe(true);
	for (const maxBudgetUsd of [
		0,
		-1,
		10000.01,
		Number.NaN,
		Number.POSITIVE_INFINITY,
		"4",
		null,
	])
		expect(SendBody.safeParse({ ...base, maxBudgetUsd }).success).toBe(false);
	expect(SendBody.safeParse({ ...base, extra: 1 }).success).toBe(false);
	expect(SendBody.safeParse({ ...base, text: " " }).success).toBe(false);
});
