import { createHash } from "node:crypto";
import {
	ConditionalCheckFailedException,
	TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
	DeleteCommand,
	type DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
	TransactWriteCommand,
	UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import type { z } from "zod";
import type {
	ConversationSummary,
	InternalIdentity,
	ListOptions,
	ListPosition,
	Scope,
	UpdateBody,
} from "./schema";

export type Conversation = Omit<ConversationSummary, "scope" | "archivedAt"> & {
	PK: string;
	SK: "META";
	userId: string;
	partnerCode: string;
	teamCode?: string;
	scope: Scope;
	archivedAt?: string;
	turnCount: number;
	deletedAt?: string;
	processing?: { turnId: string; seq: number; until: string };
	GSI1PK?: string;
	GSI1SK?: string;
};
const key = (id: string) => ({ PK: `CONV#${id}`, SK: "META" });
const listingPartition = (userId: string, archived: boolean) =>
	`USER#${userId}#${archived ? "ARCHIVED" : "ACTIVE"}`;
export function toSummary(item: Conversation): ConversationSummary {
	return {
		conversationId: item.conversationId,
		title: item.title,
		scope: item.scope.kind,
		createdAt: item.createdAt,
		lastActivityAt: item.lastActivityAt,
		archivedAt: item.archivedAt ?? null,
	};
}
export class NotFound extends Error {}
export class Processing extends Error {
	constructor(readonly turnId: string) {
		super("processing");
	}
}
export class SendConflict extends Error {
	constructor(
		readonly code: "archived" | "duplicate_request" | "request_id_conflict",
		readonly request?: { turnId: string; seq: number },
	) {
		super(code);
	}
}
export class ConversationStore {
	constructor(
		readonly db: DynamoDBDocumentClient,
		readonly table: string,
	) {}
	async get(id: string, userId: string): Promise<Conversation> {
		const { Item } = await this.db.send(
			new GetCommand({
				TableName: this.table,
				Key: key(id),
				ConsistentRead: true,
			}),
		);
		if (!Item || Item.userId !== userId || Item.deletedAt) throw new NotFound();
		return Item as Conversation;
	}
	async create(
		identity: InternalIdentity,
		body: { collectionId?: string | null; summaryId?: string | null },
	) {
		const collectionId = body.collectionId?.trim();
		const summaryId = body.summaryId?.trim();
		const scope: Scope = summaryId
			? { kind: "document", summaryId }
			: collectionId
				? { kind: "collection", collectionId }
				: { kind: "general" };
		const conversationId = crypto.randomUUID();
		const now = new Date().toISOString();
		const item: Conversation = {
			...key(conversationId),
			SK: "META",
			conversationId,
			userId: identity.memberCode,
			partnerCode: identity.partnerCode,
			...(identity.teamCode !== undefined
				? { teamCode: identity.teamCode }
				: {}),
			scope,
			title: null,
			createdAt: now,
			lastActivityAt: now,
			turnCount: 0,
			GSI1PK: listingPartition(identity.memberCode, false),
			GSI1SK: `${now}#${conversationId}`,
		};
		await this.db.send(
			new PutCommand({
				TableName: this.table,
				Item: item,
				ConditionExpression: "attribute_not_exists(PK)",
			}),
		);
		return toSummary(item);
	}
	async admit(id: string, userId: string, text: string, requestId: string) {
		const textHash = createHash("sha256").update(text).digest("hex");
		// Retry only a lost CAS (including a concurrent rename), never a won Turn.
		for (;;) {
			const conversation = await this.get(id, userId);
			const { Item: request } = await this.db.send(
				new GetCommand({
					TableName: this.table,
					Key: { PK: `CONV#${id}`, SK: `REQ#${requestId}` },
					ConsistentRead: true,
				}),
			);
			if (request)
				throw new SendConflict(
					request.textHash === textHash
						? "duplicate_request"
						: "request_id_conflict",
					{ turnId: request.turnId, seq: request.seq },
				);
			if (conversation.archivedAt) throw new SendConflict("archived");
			const startedAt = new Date().toISOString();
			if (conversation.processing && conversation.processing.until >= startedAt)
				throw new Processing(conversation.processing.turnId);
			const turnId = crypto.randomUUID();
			const seq = conversation.turnCount + 1;
			const until = new Date(Date.parse(startedAt) + 720_000).toISOString();
			try {
				await this.db.send(
					new TransactWriteCommand({
						TransactItems: [
							{
								Update: {
									TableName: this.table,
									Key: key(id),
									ConditionExpression:
										"turnCount = :count AND userId = :owner AND attribute_not_exists(deletedAt) AND attribute_not_exists(archivedAt) AND (attribute_not_exists(processing) OR processing.#until < :now) AND title = :readTitle",
									UpdateExpression:
										"SET processing = :processing, turnCount = :seq, lastActivityAt = :now, GSI1SK = :sort, title = :title, titleSearch = :search",
									ExpressionAttributeNames: { "#until": "until" },
									ExpressionAttributeValues: {
										":count": conversation.turnCount,
										":owner": userId,
										":now": startedAt,
										":processing": { turnId, seq, until },
										":seq": seq,
										":sort": `${startedAt}#${id}`,
										":readTitle": conversation.title,
										":title": conversation.title ?? text.trim().slice(0, 120),
										":search": (
											conversation.title ?? text.trim().slice(0, 120)
										).toLowerCase(),
									},
								},
							},
							{
								Put: {
									TableName: this.table,
									Item: {
										PK: `CONV#${id}`,
										SK: `REQ#${requestId}`,
										turnId,
										seq,
										textHash,
									},
									ConditionExpression: "attribute_not_exists(PK)",
								},
							},
						],
					}),
				);
				return { conversation, turnId, seq, requestId, startedAt, until };
			} catch (error) {
				if (
					!(error instanceof TransactionCanceledException) ||
					!error.CancellationReasons?.some(
						(reason) =>
							reason.Code === "ConditionalCheckFailed" ||
							reason.Code === "TransactionConflict",
					)
				)
					throw error;
			}
		}
	}
	async clearProcessing(id: string, turnId: string) {
		try {
			await this.db.send(
				new UpdateCommand({
					TableName: this.table,
					Key: key(id),
					ConditionExpression: "processing.turnId = :turnId",
					UpdateExpression: "REMOVE processing",
					ExpressionAttributeValues: { ":turnId": turnId },
				}),
			);
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) throw error;
		}
	}

	async list(query: ListOptions, after?: ListPosition) {
		const partition = listingPartition(query.userId, query.archived);
		let cursor = after
			? {
					...key(after.conversationId),
					GSI1PK: partition,
					GSI1SK: `${after.lastActivityAt}#${after.conversationId}`,
				}
			: undefined;
		const conversations: ConversationSummary[] = [];
		// Re-read base items: GSIs are eventual; a stale projection must not expose a tombstone.
		do {
			const page = await this.db.send(
				new QueryCommand({
					TableName: this.table,
					IndexName: "GSI1",
					KeyConditionExpression: "GSI1PK = :pk",
					ExpressionAttributeValues: { ":pk": partition },
					ScanIndexForward: false,
					ExclusiveStartKey: cursor,
					Limit: query.limit - conversations.length,
				}),
			);
			for (const projection of page.Items ?? []) {
				try {
					const item = await this.get(projection.conversationId, query.userId);
					if (item.GSI1PK !== partition || item.GSI1SK !== projection.GSI1SK)
						continue;
					if (
						query.search &&
						!item.title?.toLowerCase().includes(query.search.toLowerCase())
					)
						continue;
					conversations.push(toSummary(item));
				} catch (error) {
					if (!(error instanceof NotFound)) throw error;
				}
			}
			cursor = page.LastEvaluatedKey as typeof cursor;
		} while (cursor && conversations.length < query.limit);
		const next = cursor
			? {
					conversationId: String(cursor.PK).slice(5),
					lastActivityAt: String(cursor.GSI1SK).split("#")[0] as string,
				}
			: null;
		return { conversations, next };
	}
	async update(id: string, userId: string, body: z.infer<typeof UpdateBody>) {
		let expression: string;
		const values: Record<string, unknown> = { ":owner": userId };
		if ("title" in body) {
			expression = "SET title = :title, titleSearch = :search";
			values[":title"] = body.title;
			values[":search"] = body.title.toLowerCase();
		} else {
			expression = body.archived
				? "SET archivedAt = if_not_exists(archivedAt, :now), GSI1PK = :partition"
				: "SET GSI1PK = :partition REMOVE archivedAt";
			values[":partition"] = listingPartition(userId, body.archived);
			if (body.archived) values[":now"] = new Date().toISOString();
		}
		try {
			const { Attributes } = await this.db.send(
				new UpdateCommand({
					TableName: this.table,
					Key: key(id),
					ConditionExpression:
						"userId = :owner AND attribute_not_exists(deletedAt)",
					UpdateExpression: expression,
					ExpressionAttributeValues: values,
					ReturnValues: "ALL_NEW",
				}),
			);
			return toSummary(Attributes as Conversation);
		} catch (error) {
			if (error instanceof ConditionalCheckFailedException)
				throw new NotFound();
			throw error;
		}
	}
	async delete(id: string, userId: string) {
		const now = new Date().toISOString();
		try {
			await this.db.send(
				new UpdateCommand({
					TableName: this.table,
					Key: key(id),
					ConditionExpression:
						"userId = :owner AND attribute_not_exists(deletedAt) AND (attribute_not_exists(processing) OR processing.#until < :now)",
					ExpressionAttributeNames: { "#until": "until" },
					UpdateExpression:
						"SET deletedAt = :now, GSI2PK = :cleanup, GSI2SK = :now REMOVE GSI1PK, GSI1SK",
					ExpressionAttributeValues: {
						":owner": userId,
						":now": now,
						":cleanup": "CLEANUP",
					},
				}),
			);
		} catch (error) {
			if (!(error instanceof ConditionalCheckFailedException)) throw error;
			const item = await this.get(id, userId);
			throw new Processing(item.processing?.turnId ?? "");
		}
	}
	async sweep(deleteObjects: (id: string) => Promise<void> = async () => {}) {
		let cursor: Record<string, unknown> | undefined;
		do {
			const page = await this.db.send(
				new QueryCommand({
					TableName: this.table,
					IndexName: "GSI2",
					KeyConditionExpression: "GSI2PK = :cleanup",
					ExpressionAttributeValues: { ":cleanup": "CLEANUP" },
					ExclusiveStartKey: cursor,
				}),
			);
			// GSI2 sorts deletion timestamps oldest first. Emit before any fallible delete.
			if (!cursor) {
				const oldest = page.Items?.[0]?.GSI2SK;
				console.log(
					JSON.stringify({
						cleanupOldestAgeSeconds: oldest
							? Math.max(0, (Date.now() - Date.parse(oldest)) / 1000)
							: 0,
					}),
				);
			}
			for (const tombstone of page.Items ?? []) {
				const { Item } = await this.db.send(
					new GetCommand({
						TableName: this.table,
						Key: { PK: tombstone.PK, SK: "META" },
						ConsistentRead: true,
					}),
				);
				if (!Item?.deletedAt) continue;
				await deleteObjects(Item.conversationId);
				let partitionCursor: Record<string, unknown> | undefined;
				do {
					const partition = await this.db.send(
						new QueryCommand({
							TableName: this.table,
							KeyConditionExpression: "PK = :pk",
							ExpressionAttributeValues: { ":pk": tombstone.PK },
							ConsistentRead: true,
							ExclusiveStartKey: partitionCursor,
						}),
					);
					for (const item of partition.Items ?? []) {
						if (item.SK !== "META")
							await this.db.send(
								new DeleteCommand({
									TableName: this.table,
									Key: { PK: item.PK, SK: item.SK },
								}),
							);
					}
					partitionCursor = partition.LastEvaluatedKey;
				} while (partitionCursor);
				await this.db.send(
					new DeleteCommand({
						TableName: this.table,
						Key: { PK: tombstone.PK, SK: "META" },
						ConditionExpression: "deletedAt = :deleted",
						ExpressionAttributeValues: { ":deleted": Item.deletedAt },
					}),
				);
			}
			cursor = page.LastEvaluatedKey;
		} while (cursor);
	}
}
