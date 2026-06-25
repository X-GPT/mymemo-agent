import { sql } from "drizzle-orm";
import {
	bigint,
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
 * Sandbox-lease registry (MYM-17 / MYM-42). One row per conversation, keyed by
 * `(user_id, conversation_id)` — the composite primary key makes per-user /
 * per-conversation isolation a database invariant: two users, or two
 * conversations, can never resolve to one row and so can never share a sandbox.
 *
 * The row carries two concerns:
 *  - **Ownership lease** (`owner_id`, `fencing_token`, `lease_expires_at`): the
 *    concurrency control. A turn `claimLease` becomes owner via an atomic
 *    `ON CONFLICT … WHERE expired/free` CAS, heartbeats `lease_expires_at`
 *    forward while running, and clears ownership on release. A crashed owner's
 *    lease simply expires and another replica can steal it. `fencing_token` is
 *    bumped on every claim so a renew/release only affects the exact hold that
 *    acquired it (a stolen hold becomes a no-op).
 *  - **Warm-sandbox pointer** (`sandbox_id`, `agent_session_id`): a disposable
 *    optimization that survives between turns. Nullable — a freshly claimed row
 *    has no sandbox yet; only the sandbox *id* is stored (the daemon URL + edge
 *    token are recomputed from the reattached handle on reuse, never persisted).
 */
export const sandboxLeases = pgTable(
	"sandbox_leases",
	{
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** Process instance currently holding the lease; NULL between turns. */
		ownerId: text("owner_id"),
		/** Monotonic per-conversation hold counter; bumped on every claim. */
		fencingToken: bigint("fencing_token", { mode: "number" })
			.notNull()
			.default(0),
		/** Lease deadline; heartbeated forward while a turn runs. Past = free. */
		leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
		/** The warm sandbox; a reusing process reattaches to it by id. Nullable. */
		sandboxId: text("sandbox_id"),
		/** Claude SDK resume state last threaded into this conversation. */
		agentSessionId: text("agent_session_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		/** Bumped on every write so the idle reaper can age leases out. */
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
