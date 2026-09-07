import { expect, spyOn, test } from "bun:test";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { S3Client } from "@aws-sdk/client-s3";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { deleteConversationObjects } from "./cleanup";
import { ConversationStore } from "./store";

test("cleanup paginates exact prefixes, deletes transcript, and preserves tombstone on S3 partial failure", async () => {
	const s3 = new S3Client({ region: "us-west-2" });
	const send = spyOn(s3, "send");
	send
		.mockImplementationOnce(async () => ({
			Contents: [{ Key: "_history/id/one" }],
			NextContinuationToken: "next",
		}))
		.mockImplementationOnce(async () => ({}))
		.mockImplementationOnce(async () => ({
			Contents: [{ Key: "_history/id/two" }],
		}))
		.mockImplementationOnce(async () => ({}))
		.mockImplementationOnce(async () => ({}))
		.mockImplementationOnce(async () => ({}))
		.mockImplementationOnce(async () => ({}));
	await deleteConversationObjects(s3, "bucket", "id");
	expect(send.mock.calls.map(([command]) => command.input)).toEqual([
		{ Bucket: "bucket", Prefix: "_history/id/", ContinuationToken: undefined },
		{
			Bucket: "bucket",
			Delete: { Objects: [{ Key: "_history/id/one" }], Quiet: true },
		},
		{ Bucket: "bucket", Prefix: "_history/id/", ContinuationToken: "next" },
		{
			Bucket: "bucket",
			Delete: { Objects: [{ Key: "_history/id/two" }], Quiet: true },
		},
		{
			Bucket: "bucket",
			Prefix: "_workspace/id/",
			ContinuationToken: undefined,
		},
		{
			Bucket: "bucket",
			Prefix: "_artifacts/id/",
			ContinuationToken: undefined,
		},
		{ Bucket: "bucket", Key: "_transcripts/id.jsonl" },
	]);
	const db = DynamoDBDocumentClient.from(
		new DynamoDBClient({ region: "us-west-2" }),
	);
	const dbSend = spyOn(db, "send")
		.mockImplementationOnce(async () => ({ Items: [{ PK: "CONV#id" }] }))
		.mockImplementationOnce(async () => ({
			Item: { conversationId: "id", deletedAt: "now" },
		}));
	send
		.mockImplementationOnce(async () => ({
			Contents: [{ Key: "_history/id/one" }],
		}))
		.mockImplementationOnce(async () => ({
			Errors: [{ Code: "AccessDenied" }],
		}));
	await expect(
		new ConversationStore(db, "table").sweep((id) =>
			deleteConversationObjects(s3, "bucket", id),
		),
	).rejects.toThrow("cleanup failed");
	expect(dbSend).toHaveBeenCalledTimes(2);
	send.mockRestore();
	dbSend.mockRestore();
	s3.destroy();
	db.destroy();
});
