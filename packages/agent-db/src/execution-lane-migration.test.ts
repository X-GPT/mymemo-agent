import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_DIR } from "./migrations";

let db: PGlite;

beforeAll(async () => {
	db = new PGlite();
	await db.waitReady;
	await db.exec(`
		CREATE TABLE conversations (
			user_id text NOT NULL,
			conversation_id text NOT NULL,
			scope text NOT NULL,
			PRIMARY KEY (user_id, conversation_id)
		);
		INSERT INTO conversations (user_id, conversation_id, scope)
		VALUES ('existing-user', 'existing-conversation', 'general');
	`);
	const migration = await readFile(
		join(MIGRATIONS_DIR, "0018_conversation_execution_lane.sql"),
		"utf8",
	);
	for (const statement of migration.split("--> statement-breakpoint")) {
		if (statement.trim()) await db.exec(statement);
	}
});

afterAll(async () => {
	await db.close();
});

describe("Conversation execution lane migration", () => {
	it("backfills existing Conversations and defaults new Conversations to Fargate", async () => {
		await db.exec(`
			INSERT INTO conversations (user_id, conversation_id, scope)
			VALUES ('new-user', 'new-conversation', 'general')
		`);

		const result = await db.query<{
			conversation_id: string;
			execution_lane: string;
		}>(`
			SELECT conversation_id, execution_lane
			FROM conversations
			ORDER BY conversation_id
		`);

		expect(result.rows).toEqual([
			{
				conversation_id: "existing-conversation",
				execution_lane: "fargate",
			},
			{ conversation_id: "new-conversation", execution_lane: "fargate" },
		]);
	});

	it("accepts only the two execution lanes and never null", async () => {
		await db.exec(`
			INSERT INTO conversations
				(user_id, conversation_id, scope, execution_lane)
			VALUES ('canary-user', 'canary-conversation', 'general', 'agentcore_canary')
		`);
		await expect(
			db.exec(`
				INSERT INTO conversations
					(user_id, conversation_id, scope, execution_lane)
				VALUES ('bad-user', 'bad-conversation', 'general', 'unknown')
			`),
		).rejects.toThrow();
		await expect(
			db.exec(`
				INSERT INTO conversations
					(user_id, conversation_id, scope, execution_lane)
				VALUES ('null-user', 'null-conversation', 'general', NULL)
			`),
		).rejects.toThrow();
	});
});
