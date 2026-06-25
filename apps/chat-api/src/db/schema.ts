import { sql } from "drizzle-orm";
import {
	check,
	pgTable,
	primaryKey,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for chat-api's own writable database (`mymemo_agent`), distinct
 * from the gateway's read-only KB. This file is the single source of truth for
 * the writable DB: types are inferred from it, and `drizzle-kit generate` emits
 * the SQL migrations under `drizzle/` from it. Do not hand-edit the generated
 * DDL — change a table here and regenerate.
 */

/**
 * Sandbox-lease registry (MYM-17). Maps one conversation to the warm sandbox
 * currently serving it. The composite primary key makes per-user / per-
 * conversation isolation a database invariant: two users, or two conversations,
 * can never resolve to one row and so can never share a leased sandbox.
 *
 * Only the sandbox *id* is stored; the daemon URL and per-sandbox edge token are
 * recomputed from the reattached handle on reuse, never persisted.
 */
export const sandboxLeases = pgTable(
	"sandbox_leases",
	{
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** The leased sandbox; a reusing process reattaches to it by id. */
		sandboxId: text("sandbox_id").notNull(),
		/** Claude SDK resume state last threaded into this conversation. */
		agentSessionId: text("agent_session_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		/** Bumped on every upsert so the idle reaper can age leases out. */
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.conversationId] })],
);

/**
 * Durable conversation record — the source of truth for a conversation's
 * immutable document scope, keyed like the lease by `(user_id, conversation_id)`.
 * Kept separate from `sandbox_leases` on purpose: the lease is a disposable
 * optimization the reaper may delete, whereas the scope is a correctness/
 * security boundary that must outlive any sandbox. Created once and never
 * re-scoped (the scope columns are written at creation and read each turn).
 */
export const conversations = pgTable(
	"conversations",
	{
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** 'general' | 'collection' | 'document' — frozen at creation. */
		scope: text("scope").notNull(),
		/** Non-null only for collection scope. */
		collectionId: text("collection_id"),
		/** Non-null only for document scope. */
		summaryId: text("summary_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.conversationId] }),
		// scope is the frozen security boundary; defend the legal values at the DB
		// so a bad write (manual ops, a future writer, a bug) cannot forge a scope
		// the read-side `as ConversationScope` cast would otherwise trust.
		check(
			"conversations_scope_check",
			sql`${t.scope} in ('general', 'collection', 'document')`,
		),
	],
);
