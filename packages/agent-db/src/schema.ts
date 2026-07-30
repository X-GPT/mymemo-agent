import { sql } from "drizzle-orm";
import {
	bigint,
	bigserial,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Drizzle schema for the writable agent database (`mymemo_agent`), distinct from
 * the worker's read-only KB. This file is the single source of truth for the
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
 * active execution ownership** — that lives exclusively in `runs`. Sandbox and
 * taint mutations use the runtime-store helpers; Agent-session pointer updates
 * compose through run-store's terminal transaction. Both paths fence on the
 * claiming Run's `locked_by`/`locked_until`, so a worker that lost its Run
 * cannot overwrite pointers a recovered Conversation now relies on.
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
		 * failed command-tree kill): the sandbox must not be reused until
		 * replaced. Reset whenever the pointer is replaced or cleared — taint
		 * describes the current sandbox only.
		 */
		sandboxTainted: boolean("sandbox_tainted").notNull().default(false),
		/**
		 * The Claude Agent SDK session to resume this conversation from (ADR-0005):
		 * the main-session id the bound SessionStore proves through a successful
		 * non-empty transcript mirror. NULL until that evidence exists — a Run with
		 * no pointer starts a fresh Agent session. The first value and every later
		 * advance are published ONLY in the same ownership-fenced transaction as
		 * `done` or `interrupted`; recovery and a Run that observed `mirror_error`
		 * leave it unchanged.
		 */
		agentSessionId: text("agent_session_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [primaryKey({ columns: [t.userId, t.conversationId] })],
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
		/** User-visible label, initialized by the first admitted User message. */
		title: text("title"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		/** Creation, or the most recent successfully admitted User message. */
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		/** Non-null while the Conversation is archived. */
		archivedAt: timestamp("archived_at", { withTimezone: true }),
		/**
		 * The worker holding the current Claim. Provenance for log correlation
		 * only — it carries no safety weight, because an epoch names exactly one
		 * Claim and therefore exactly one worker. NULL while unowned.
		 */
		ownerWorkerId: text("owner_worker_id"),
		/** Deadline of the current Ownership lease; NULL while unowned. */
		ownerUntil: timestamp("owner_until", { withTimezone: true }),
		/**
		 * Ownership epoch (ADR-0015): incremented by every Claim, so it names one
		 * Claim of this Conversation. Fenced writes validate a matching epoch
		 * **and** a live `owner_until` — the two conjuncts cover different
		 * failures, the epoch a lease superseded by a re-Claim and the deadline
		 * one that merely lapsed with no successor. A token is necessary rather
		 * than redundant here precisely because a Conversation is claimed many
		 * times across its life, by different workers; the older
		 * claimed-exactly-once argument does not survive that.
		 */
		epoch: integer("epoch").notNull().default(0),
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
		index("conversations_regular_activity_idx")
			.on(t.userId, t.lastActivityAt, t.conversationId)
			.where(sql`${t.archivedAt} is null`),
		index("conversations_archived_activity_idx")
			.on(t.userId, t.lastActivityAt, t.conversationId)
			.where(sql`${t.archivedAt} is not null`),
		// Reclamation candidates: Conversations still holding an Ownership lease,
		// which is where a lapsed one is found. Partial on the deadline because
		// unowned Conversations are the overwhelming majority and none of them is
		// ever a candidate.
		index("conversations_reclamation_idx")
			.on(t.ownerUntil)
			.where(sql`${t.ownerUntil} is not null`),
	],
);

/**
 * The current Downloadable artifact at each normalized conversation-relative
 * path (ADR-0011). Postgres is the read-model authority: clients never list S3
 * objects directly. Replacing an artifact updates this row in place so its
 * opaque `artifact_id`, path identity, and `created_at` remain stable while the
 * current object reference and metadata change.
 */
export const conversationArtifacts = pgTable(
	"conversation_artifacts",
	{
		artifactId: text("artifact_id").primaryKey(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** Normalized POSIX path relative to `/home/user/artifacts/`. */
		path: text("path").notNull(),
		/** Private object-store reference; never exposed in list responses. */
		objectKey: text("object_key").notNull(),
		sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
		/** Trusted server-selected type, not sandbox-provided metadata. */
		contentType: text("content_type").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		uniqueIndex("conversation_artifacts_owner_conversation_path_idx").on(
			t.userId,
			t.conversationId,
			t.path,
		),
		foreignKey({
			columns: [t.userId, t.conversationId],
			foreignColumns: [conversations.userId, conversations.conversationId],
			name: "conversation_artifacts_conversation_fk",
		}).onDelete("cascade"),
		check("conversation_artifacts_size_bytes_check", sql`${t.sizeBytes} >= 0`),
	],
);

/**
 * Internal lifecycle ledger for every private object a Run intends to upload.
 * Rows are inserted before object-store I/O so a worker crash cannot create an
 * untracked object. Current reachability still comes from
 * `conversation_artifacts`; this ledger exists for crash-safe cleanup, not as
 * user-visible version history (ADR-0011).
 */
export const artifactObjects = pgTable(
	"artifact_objects",
	{
		objectKey: text("object_key").primaryKey(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		runId: text("run_id").notNull(),
		path: text("path").notNull(),
		status: text("status").notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		committedAt: timestamp("committed_at", { withTimezone: true }),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
	},
	(t) => [
		index("artifact_objects_run_idx").on(t.runId),
		index("artifact_objects_status_idx").on(t.status),
		check(
			"artifact_objects_status_check",
			sql`${t.status} in ('pending', 'current', 'superseded')`,
		),
	],
);

/**
 * The Run statuses that make a Run *Active* — submitted and not yet at its
 * Outcome. One definition, because two things must agree on it byte for byte:
 * admission's Active Run bound (`run-store.ts`) and the partial predicate of
 * `runs_conversation_active_idx` below, which is what keeps that bound check off
 * a sequential scan. Drift between them is silent — the query keeps working and
 * simply stops using the index.
 */
export const ACTIVE_RUN_STATUSES = [
	"queued",
	"running",
	"interrupt_requested",
] as const;

/** {@link ACTIVE_RUN_STATUSES} as an inlined SQL literal list. `sql.raw` rather
 * than a bound parameter because drizzle-kit serializes this predicate into
 * migration DDL, where a placeholder would be meaningless. */
const ACTIVE_RUN_STATUS_LIST = sql.raw(
	ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", "),
);

/**
 * Durable run queue for the split-runtime worker (milestone 1). A run is one
 * backend execution attempt for a conversation. Execution ownership lives
 * here, not in sandbox/runtime metadata: only the worker named by `locked_by`
 * while `locked_until` is live may append owned run events in later
 * transaction helpers. This lease carries no fencing token, on the argument
 * that a v1 run is claimed exactly once (failed runs never requeue; stale runs
 * are terminalized, never reclaimed).
 *
 * That argument does not survive Conversation-level ownership (ADR-0015), where
 * one Conversation is Claimed many times by different workers. The token now
 * exists, as `conversations.epoch`; this lease is only what fenced writes still
 * evaluate until they move onto it.
 */
export const runs = pgTable(
	"runs",
	{
		/** Primary/canonical external run id. */
		runId: text("run_id").primaryKey(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/**
		 * Versioned, server-normalized client input used only for admission
		 * idempotency. NULL identifies Runs written before the AG-UI contract.
		 */
		normalizedInput: jsonb("normalized_input"),
		status: text("status").notNull(),
		lockedBy: text("locked_by"),
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		/**
		 * Which worker executed this Run, recorded when it starts. Provenance for
		 * log correlation, never authority — that is the Conversation's Ownership
		 * lease. Nothing writes it yet: the queued→running transition stamps it
		 * when it adopts the epoch fence.
		 */
		executedByWorkerId: text("executed_by_worker_id"),
		heartbeatAt: timestamp("heartbeat_at", { withTimezone: true }),
		interruptRequestedAt: timestamp("interrupt_requested_at", {
			withTimezone: true,
		}),
		/** Monotonic marker that Live delivery is unavailable for this Run. */
		liveStreamFailedAt: timestamp("live_stream_failed_at", {
			withTimezone: true,
		}),
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
			sql`${t.status} in ('queued', 'running', 'interrupt_requested', 'done', 'error', 'interrupted')`,
		),
		foreignKey({
			columns: [t.userId, t.conversationId],
			foreignColumns: [conversations.userId, conversations.conversationId],
			name: "runs_conversation_fk",
		}).onDelete("cascade"),
		// A conversation's Active Runs. Deliberately **not** unique — it constrains
		// nothing. The Active Run bound is admission's explicit check under the
		// Conversation row lock (`admitQueuedRunInTx`), so the database no longer
		// guarantees that a writer starts one Run at a time. What survives here is
		// only the access path `runs_one_active_per_conversation` also happened to
		// provide, which four hot reads need: admission's bound check, the
		// Archive/Permanent-deletion guard, the Claim's snapshot (`status =
		// 'queued'` sits inside this predicate), and the history store's captured
		// active Run.
		// Partial on purpose: one entry per *Active* Run keeps it sized by
		// concurrently-busy conversations rather than by every Run ever admitted.
		index("runs_conversation_active_idx")
			.on(t.userId, t.conversationId)
			.where(sql`${t.status} in (${ACTIVE_RUN_STATUS_LIST})`),
		// Queue claim: oldest queued run first (`FOR UPDATE SKIP LOCKED` scan).
		index("runs_queue_claim_idx")
			.on(t.createdAt)
			.where(sql`${t.status} = 'queued'`),
		// Stale-run recovery: active runs whose lock deadline has passed.
		index("runs_stale_recovery_idx")
			.on(t.lockedUntil)
			.where(sql`${t.status} in ('running', 'interrupt_requested')`),
		// Cleanup/retention: terminal runs by when they finished.
		index("runs_cleanup_idx")
			.on(t.terminalAt)
			.where(sql`${t.status} in ('done', 'error', 'interrupted')`),
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
 * The Claude Agent SDK session-transcript mirror — the backing table for the
 * worker's `SessionStore` adapter (ADR-0005, Task 7.3). One row per transcript
 * entry (a JSONL line the SDK mirrors after its local write), insertion-ordered
 * by the `bigserial` id so a session replays in the order it was appended.
 *
 * The SDK identifies a transcript by `(projectKey, sessionId, subpath)` and the
 * adapter stores all three, but the stable identity the adapter binds every call
 * to is `conversation_id`: `project_key` is the SDK's cwd-derived view of the
 * same conversation (kept stable by a deterministic per-conversation query cwd,
 * and recorded here for fidelity), while `conversation_id` is what makes
 * conversation-scoped deletion exact without reconstructing the SDK's cwd→key
 * sanitization. `subpath` is `''` for the main transcript and a non-empty
 * `subagents/agent-…` key for subagent transcripts.
 *
 * Worker-only: chat-api never reads or writes it. No FK to `conversations` —
 * transcript retention is the adapter's job (deletion runs in the periodic
 * cleanup loop's deleted-conversation sweep), and a cascade would couple the
 * two.
 */
export const agentSessions = pgTable(
	"agent_sessions",
	{
		/** Insertion order within a transcript; the replay sort key. */
		id: bigserial("id", { mode: "number" }).primaryKey(),
		conversationId: text("conversation_id").notNull(),
		projectKey: text("project_key").notNull(),
		sessionId: text("session_id").notNull(),
		/** `''` = main transcript; a `subagents/agent-…` key = subagent transcript. */
		subpath: text("subpath").notNull().default(""),
		/**
		 * The entry's `uuid` when it carries one, else NULL. Dedup keys on it so a
		 * re-delivered batch (the SDK's at-most-once mirror may retry a failed
		 * append) does not double-insert; entries without a uuid cannot be deduped
		 * and always insert (NULLs are distinct in the unique index below).
		 */
		uuid: text("uuid"),
		/** The opaque JSONL transcript line, round-tripped as-is. */
		entry: jsonb("entry").notNull(),
		/**
		 * The Ownership epoch of the Claim that mirrored this entry — provenance,
		 * not a fence. Resume stays pointer-driven and never consults it; it
		 * exists so "which Claim wrote this transcript" is answerable when a dead
		 * attempt's transcript is the newest one. Nullable: entries mirrored
		 * before Conversation ownership carry no epoch, and nothing writes it yet.
		 */
		epoch: integer("epoch"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		// Dedup by entry uuid within a transcript. Non-partial on purpose: Postgres
		// treats NULL as distinct, so uuid-less entries never collide and always
		// insert, while `ON CONFLICT DO NOTHING` drops a re-delivered uuid.
		uniqueIndex("agent_sessions_dedup_idx").on(
			t.conversationId,
			t.sessionId,
			t.subpath,
			t.uuid,
		),
		// Load/listSubkeys: read one transcript's entries in insertion order.
		index("agent_sessions_transcript_idx").on(
			t.conversationId,
			t.sessionId,
			t.subpath,
			t.id,
		),
		// Conversation-scoped deletion (conversation delete / periodic cleanup).
		index("agent_sessions_conversation_idx").on(t.conversationId),
	],
);

/**
 * Audit ledger for trusted document access performed by agent-worker: which
 * scoped documents a run listed, searched, or loaded, under which scope
 * filter. Kept separate from `run_events` because its job differs —
 * security/compliance queries, and retention/access controls that can diverge
 * from chat-visible run events. For that same reason there is deliberately no
 * FK to `runs`:
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
		/** 'search' | 'list' | 'load'. */
		operation: text("operation").notNull(),
		/** The scope filter the access was policy-checked against. */
		scopeType: text("scope_type").notNull(),
		/** Collection/summary id for scoped access; NULL for general scope. */
		scopeId: text("scope_id"),
		/** Search query text; NULL for list/load access. */
		query: text("query"),
		/** Page/search/load document ids; empty for an empty list/search result. */
		documentIds: text("document_ids").array().notNull(),
		/** Operation-defined count returned to the model; NULL on historical rows. */
		resultCount: integer("result_count"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		check(
			"document_access_events_operation_check",
			sql`${t.operation} in ('search', 'list', 'load')`,
		),
		check(
			"document_access_events_scope_type_check",
			sql`${t.scopeType} in ('general', 'collection', 'document')`,
		),
		// Audit query path: "which documents did this run list, search, or load?"
		index("document_access_events_run_id_idx").on(t.runId),
		// Retention sweeps age the ledger out by time, independent of runs.
		index("document_access_events_created_at_idx").on(t.createdAt),
	],
);
