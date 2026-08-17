import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { MIGRATIONS_DIR } from "./migrations";

const CUTOVER_MIGRATION = "0023_execution_runtime.sql";

async function applySql(client: PGlite, migrationSql: string): Promise<void> {
	for (const statement of migrationSql.split("--> statement-breakpoint")) {
		if (statement.trim()) await client.exec(statement);
	}
}

describe("execution-runtime cutover migration", () => {
	it("aborts before renaming when a legacy AgentCore-canary Conversation exists", async () => {
		const client = new PGlite();
		try {
			await client.waitReady;
			for (const file of readdirSync(MIGRATIONS_DIR)
				.filter((file) => file.endsWith(".sql") && file < CUTOVER_MIGRATION)
				.sort()) {
				await applySql(
					client,
					readFileSync(join(MIGRATIONS_DIR, file), "utf8"),
				);
			}
			await client.exec(`
				insert into conversations (
					user_id,
					conversation_id,
					scope,
					execution_lane
				) values ('legacy-user', 'legacy-conversation', 'general', 'agentcore_canary')
			`);

			await expect(
				applySql(
					client,
					readFileSync(join(MIGRATIONS_DIR, CUTOVER_MIGRATION), "utf8"),
				),
			).rejects.toThrow(
				"execution-runtime cutover refused while agentcore_canary Conversations exist",
			);
			const { rows: columns } = await client.query<{ column_name: string }>(`
				select column_name
				from information_schema.columns
				where table_schema = 'public'
					and table_name = 'conversations'
					and column_name in ('execution_lane', 'execution_runtime')
			`);
			expect(columns).toEqual([{ column_name: "execution_lane" }]);
		} finally {
			await client.close();
			(client as unknown as { mod?: unknown }).mod = undefined;
			Bun.gc(true);
		}
	});
});
