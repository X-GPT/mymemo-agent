import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
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
 * Drizzle schema for the writable agent database (`mymemo_agent`), distinct from
 * the gateway's read-only KB. This file is the single source of truth for the
 * writable DB shared by `chat-api` (run creation, SSE projection) and
 * `agent-worker` (the claim/heartbeat/terminalize loop): types are inferred from
 * it, and `drizzle-kit generate` emits the SQL migrations under `drizzle/` from
 * it. Do not hand-edit the generated DDL — change a table here and regenerate.
 */

/**
 * Persistent E2B workspace metadata (Task 4.2 / ADR-0002): one row per
 * `(user_id, conversation_id)` — the composite primary key makes per-user /
 * per-conversation isolation a database invariant. This row replaces the old
 * `sandbox_leases` warm-pointer role only; unlike the lease it grants **no
 * active execution ownership** — that lives exclusively in `runs`, and every
 * mutation here must be fenced on the claiming run's `locked_by`/`locked_until`
 * through the conversation-runtime-store helpers, so a worker that lost its
 * run cannot overwrite pointers a recovered conversation now relies on.
 */
export const conversationRuntime = pgTable(
	"conversation_runtime",
	{
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** Current E2B sandbox (running or paused); NULL when none exists. */
		sandboxId: text("sandbox_id"),
		/**
		 * True when command cleanup could not be proven (stale-run recovery,
		 * failed command-tree kill): the sandbox must not be snapshotted or
		 * reused until cleanup proves otherwise. Reset whenever the pointer is
		 * replaced or cleared — taint describes the current sandbox only.
		 */
		sandboxTainted: boolean("sandbox_tainted").notNull().default(false),
		/** Newest successful checkpoint; the product restore path. */
		latestSnapshotId: text("latest_snapshot_id"),
		/** Prior successful checkpoint, kept for operator-driven rollback. */
		previousSnapshotId: text("previous_snapshot_id"),
		/**
		 * 'clean' = the workspace holds no user work newer than
		 * `latest_snapshot_id` (or is fresh); 'dirty_uncheckpointed' = a
		 * checkpoint failed after user work, so the next turn must reconnect
		 * and checkpoint before anything else.
		 */
		workspaceCheckpointStatus: text("workspace_checkpoint_status")
			.notNull()
			.default("clean"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.conversationId] }),
		check(
			"conversation_runtime_checkpoint_status_check",
			sql`${t.workspaceCheckpointStatus} in ('clean', 'dirty_uncheckpointed')`,
		),
	],
);

/**
 * Recovery ledger for E2B sandboxes created but never safely stored as the
 * current `conversation_runtime.sandbox_id` (run ownership lost before the
 * fenced update, kill unconfirmed). Deliberately no FK to `runs` and no
 * ownership fence on inserts: recording happens precisely when ownership was
 * already lost, and the ledger must survive run cleanup — it is the only
 * database record keeping a paid external resource inside ownership. The
 * cleanup job kills entries after verifying they are not the current
 * `conversation_runtime.sandbox_id`.
 */
export const orphanSandboxes = pgTable("orphan_sandboxes", {
	/** PK: recording the same sandbox twice is an idempotent no-op. */
	sandboxId: text("sandbox_id").primaryKey(),
	userId: text("user_id").notNull(),
	conversationId: text("conversation_id").notNull(),
	runId: text("run_id").notNull(),
	createdByWorkerId: text("created_by_worker_id").notNull(),
	/** Why the sandbox escaped ownership, for operators (free text). */
	reason: text("reason").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
});

/**
 * Durable conversation record — the source of truth for a conversation's
 * immutable document scope, keyed like the lease by `(user_id, conversation_id)`.
 * Kept separate from `conversation_runtime` on purpose: runtime rows are
 * disposable workspace metadata cleanup may delete, whereas the scope is a
 * correctness/security boundary that must outlive any sandbox. Created once and never
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
