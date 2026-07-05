import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	check,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
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

/**
 * Durable run queue for the split-runtime worker (milestone 1). A run is one
 * backend execution attempt for a conversation. Execution ownership lives
 * here, not in sandbox/runtime metadata: only the worker named by `locked_by`
 * while `locked_until` is live may append owned run events in later
 * transaction helpers. There is deliberately no fencing token: a v1 run is
 * claimed exactly once (failed runs never requeue; stale runs are
 * terminalized, never reclaimed), so `locked_by` + `locked_until` is the
 * complete ownership fence — a token returns only with a future requeue
 * feature, in the same PR as that feature.
 */
export const runs = pgTable(
	"runs",
	{
		/** Primary/canonical external run id. */
		runId: text("run_id").primaryKey(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		status: text("status").notNull(),
		lockedBy: text("locked_by"),
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		cancelRequestedAt: timestamp("cancel_requested_at", { withTimezone: true }),
		nextEventSeq: bigint("next_event_seq", { mode: "number" })
			.notNull()
			.default(1),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		terminalAt: timestamp("terminal_at", { withTimezone: true }),
	},
	(t) => [
		check(
			"runs_status_check",
			sql`${t.status} in ('queued', 'running', 'cancel_requested', 'done', 'error', 'canceled')`,
		),
		uniqueIndex("runs_one_active_per_conversation")
			.on(t.userId, t.conversationId)
			.where(sql`${t.status} in ('queued', 'running', 'cancel_requested')`),
		// Queue claim: oldest queued run first (`FOR UPDATE SKIP LOCKED` scan).
		index("runs_queue_claim_idx")
			.on(t.createdAt)
			.where(sql`${t.status} = 'queued'`),
		// Stale-run recovery: active runs whose lock deadline has passed.
		index("runs_stale_recovery_idx")
			.on(t.lockedUntil)
			.where(sql`${t.status} in ('running', 'cancel_requested')`),
		// Cleanup/retention: terminal runs by when they finished.
		index("runs_cleanup_idx")
			.on(t.terminalAt)
			.where(sql`${t.status} in ('done', 'error', 'canceled')`),
	],
);

/**
 * Durable, ordered run event log. Milestone 1 records events only; it does not
 * define SSE frame names, payload shapes, or projection rules. There is no
 * `visibility` column: the projector's event-type→frame mapping is the single
 * authority for client exposure, and unmapped types are skipped (fail-closed —
 * a new internal event type cannot leak to clients without an explicit frame
 * mapping). The composite primary key doubles as the SSE replay index
 * (`WHERE run_id = ? AND seq > ?` ordered by seq).
 */
export const runEvents = pgTable(
	"run_events",
	{
		runId: text("run_id")
			.notNull()
			.references(() => runs.runId, { onDelete: "cascade" }),
		seq: bigint("seq", { mode: "number" }).notNull(),
		type: text("type").notNull(),
		payload: jsonb("payload").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.runId, t.seq] })],
);

/**
 * Audit ledger for trusted document access performed by agent-worker: which
 * scoped documents a run searched or fetched, under which scope filter. Kept
 * separate from `run_events` because its job differs — security/compliance
 * queries, and retention/access controls that can diverge from chat-visible
 * run events. For that same reason there is deliberately no FK to `runs`:
 * audit rows must survive run cleanup, so cascade would erase the ledger and
 * restrict would block retention. Full document content is never stored here.
 */
export const documentAccessEvents = pgTable(
	"document_access_events",
	{
		id: bigserial("id", { mode: "number" }).primaryKey(),
		runId: text("run_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		userId: text("user_id").notNull(),
		/** The scope filter the access was policy-checked against. */
		scopeType: text("scope_type").notNull(),
		/** Collection/summary id for scoped access; NULL for general scope. */
		scopeId: text("scope_id"),
		/** Search query text; NULL for direct fetch/load access. */
		query: text("query"),
		/** Document ids returned/fetched; empty array for a no-hit search. */
		documentIds: text("document_ids").array().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		check(
			"document_access_events_scope_type_check",
			sql`${t.scopeType} in ('general', 'collection', 'document')`,
		),
		// Audit query path: "which documents did this run search or fetch?"
		index("document_access_events_run_id_idx").on(t.runId),
		// Retention sweeps age the ledger out by time, independent of runs.
		index("document_access_events_created_at_idx").on(t.createdAt),
	],
);
