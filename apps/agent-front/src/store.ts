import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
	DeleteCommand,
	type DynamoDBDocumentClient,
	GetCommand,
	PutCommand,
	QueryCommand,
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
