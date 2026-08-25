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
 * the Runtime's read-only KB. This file is the single source of truth for the
 * writable DB shared by `chat-api` (run creation, SSE projection) and
 * AgentCore and agent-maintenance: types are inferred from
 * it, and `drizzle-kit generate` emits the SQL migrations under `drizzle/` from
 * it. Do not hand-edit the generated DDL — change a table here and regenerate.
 */

/**
 * Persistent E2B workspace metadata (Task 4.2 / ADR-0002): one row per
 * `(user_id, conversation_id)` — the composite primary key makes per-user /
 * per-conversation isolation a database invariant. This row replaces the old
 * `sandbox_leases` warm-pointer role only; unlike the lease it grants **no
 * active execution ownership** — that lives exclusively on the Conversation.
 * Run sandbox/taint mutations and terminal Agent-session pointer updates fence
 * on live Conversation Ownership. The Run-free Agent-query Workspace and
 * completion paths instead fence on live Response authority. Both validate the
 * Conversation epoch and its Ownership lease or Response deadline, so a stale
 * Runtime invocation cannot overwrite a later authority grant's pointers.
 */
export const conversationRuntime = pgTable(
	"conversation_runtime",
	{
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		/** Current E2B sandbox (running or paused); NULL when none exists. */
		sandboxId: text("sandbox_id"),
		/**
		 * True when command cleanup could not be proven (Reclamation,
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
		 * advance are published either with a Run's terminal Outcome in its
		 * Ownership-fenced transaction or with a direct response's Assistant message
		 * in its Response-authority-fenced completion transaction. Recovery and any
		 * execution that observed `mirror_error` leave it unchanged.
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
		 * The current execution authority's provenance label. It carries no safety
		 * weight — the Conversation epoch/deadline carry safety. NULL while idle.
		 */
		ownerWorkerId: text("owner_worker_id"),
		/** Current Ownership lease or Response deadline; NULL while idle. */
		ownerUntil: timestamp("owner_until", { withTimezone: true }),
		/** Redis-backed AI SDK stream currently resumable by the browser. */
		activeStreamId: text("active_stream_id"),
		/**
		 * Conversation epoch (ADR-0015, ADR-0033): incremented by every Durable
		 * acquisition or direct-response admission, so it identifies one execution-
		 * authority grant. Fenced writes validate both a matching epoch and a live
		 * `owner_until`; the epoch rejects a superseded grant and the deadline rejects
		 * one that lapsed without a successor.
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
 * Canonical AI SDK messages for the direct-response expansion path. The
 * browser-facing representation is stored intact as role plus parts; the
 * monotonically increasing sequence supplies deterministic Conversation order.
 * This table is not read by the production Run/AG-UI path before cutover.
 */
export const conversationMessages = pgTable(
	"conversation_messages",
	{
		sequence: bigserial("sequence", { mode: "number" }).notNull().unique(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		messageId: text("message_id").notNull(),
		role: text("role").notNull(),
		parts: jsonb("parts").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(t) => [
		primaryKey({ columns: [t.userId, t.conversationId, t.messageId] }),
		foreignKey({
			columns: [t.userId, t.conversationId],
			foreignColumns: [conversations.userId, conversations.conversationId],
			name: "conversation_messages_conversation_fk",
		}).onDelete("cascade"),
		check(
			"conversation_messages_role_check",
			sql`${t.role} in ('user', 'assistant')`,
		),
		index("conversation_messages_order_idx").on(
			t.userId,
			t.conversationId,
			t.sequence,
		),
	],
);

/**
 * Non-cascading transactional outbox for AgentCore dispatch. A Run id is the
 * dispatch identity, so the primary key enforces at most one dispatch per Run.
 * It stores only identifiers and timestamps; no prompt, model content, document
 * details, artifact data, or credentials can enter the queue boundary through
 * this record. Publication uses an expiring database lease; a confirmed send
 * advances `published_at`, while an ambiguous send becomes eligible again only
 * after `publish_claim_until`. The deprecated replay columns remain for one
 * rolling-deploy compatibility release; the current publisher does not read or
 * write them.
 */
export const agentCoreDispatchOutbox = pgTable(
	"agentcore_dispatch_outbox",
	{
		runId: text("run_id").primaryKey(),
		userId: text("user_id").notNull(),
		conversationId: text("conversation_id").notNull(),
		admittedAt: timestamp("admitted_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		publishClaimedBy: text("publish_claimed_by"),
		publishClaimUntil: timestamp("publish_claim_until", {
			withTimezone: true,
		}),
		publishAttempts: integer("publish_attempts").notNull().default(0),
		replayRequestedAt: timestamp("replay_requested_at", {
			withTimezone: true,
		}),
		replayRequestedBy: text("replay_requested_by"),
	},
	(t) => [
		index("agentcore_dispatch_outbox_pending_idx")
			.on(t.admittedAt)
			.where(sql`${t.publishedAt} is null`),
		index("agentcore_dispatch_outbox_publish_claim_idx").on(
			t.publishClaimUntil,
		),
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
 * Rows are inserted before object-store I/O so a Runtime crash cannot create an
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

/**
 * The Run statuses that are an Outcome — the Run is finished and will not
 * change again. Shared for the same reason as {@link ACTIVE_RUN_STATUSES}:
 * history's completed-Run paging, the cleanup sweep, and the
 * `runs_cleanup_idx` predicate all have to mean the same three.
 */
export const TERMINAL_RUN_STATUSES = ["done", "error", "interrupted"] as const;

/**
 * Every legal `runs.status`. Spelling it as the two halves is what makes
 * "a Run is Active or it is an Outcome, never both and never neither" true by
 * construction rather than by three lists agreeing — `runs_status_check` below
 * and the `RunStatus` union in `run-store.ts` are both derived from it.
 */
export const ALL_RUN_STATUSES = [
	...ACTIVE_RUN_STATUSES,
	...TERMINAL_RUN_STATUSES,
] as const;

/** A status tuple as an inlined SQL literal list. `sql.raw` rather than bound
 * parameters because drizzle-kit serializes these predicates into migration
 * DDL, where a placeholder would be meaningless. */
function statusList(statuses: readonly string[]) {
	return sql.raw(statuses.map((status) => `'${status}'`).join(", "));
}

/**
 * Durable Run queue for AgentCore. Execution authority lives on
 * the Conversation and every write validates its live Ownership epoch
 * (ADR-0015). The epoch is necessary because a Conversation can be acquired
 * many times over its life: Runtime identity cannot distinguish a stale holder
 * from its successor.
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
		/**
		 * Which Runtime invocation executed this Run, stamped by the epoch-fenced
		 * queued→running transition. Provenance for log correlation, never authority
		 * — that is the Conversation's Ownership lease.
		 */
		executedByWorkerId: text("executed_by_worker_id"),
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
		/**
		 * Last state or liveness change. While queued, Reclamation refreshes this
		 * as the unowned queue-backstop clock without changing createdAt ordering.
		 */
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		terminalAt: timestamp("terminal_at", { withTimezone: true }),
	},
	(t) => [
		check(
			"runs_status_check",
			sql`${t.status} in (${statusList(ALL_RUN_STATUSES)})`,
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
		// Archive/Permanent-deletion guard, the Durable-acquisition candidate read
		// (`status = 'queued'` sits inside this predicate), and history's captured
		// active Run.
		// Partial on purpose: one entry per *Active* Run keeps it sized by
		// concurrently-busy conversations rather than by every Run ever admitted.
		index("runs_conversation_active_idx")
			.on(t.userId, t.conversationId)
			.where(sql`${t.status} in (${statusList(ACTIVE_RUN_STATUSES)})`),
		// Cleanup/retention: terminal runs by when they finished.
		index("runs_cleanup_idx")
			.on(t.terminalAt)
			.where(sql`${t.status} in (${statusList(TERMINAL_RUN_STATUSES)})`),
		// History paging: one Conversation's Outcomes. The equality pair plus the
		// partial predicate is the whole access path — it turns a sequential scan of
		// every Run ever admitted into an index scan of one Conversation's.
		// It deliberately stops there. The paging query orders by
		// `date_trunc('milliseconds', created_at)` (`RUN_ORDER_CREATED_AT` in
		// chat-api's history store), and no btree on the raw column can match an
		// expression sort key, so Postgres top-N sorts either way — trailing
		// `created_at, run_id` measured as pure index width: same `Index Cond`,
		// same buffers, same sort.
		// So cost tracks the Conversation's history length, not the page size. Fine
		// at realistic lengths; a Conversation reaching thousands of Runs is when the
		// indexable `date_trunc(... AT TIME ZONE 'UTC')` would start to earn the
		// app-visible expression rewrite it requires.
		// The predicate makes this the exact complement of
		// `runs_conversation_active_idx`: between them they partition the table.
		index("runs_history_paging_idx")
			.on(t.userId, t.conversationId)
			.where(sql`${t.status} in (${statusList(TERMINAL_RUN_STATUSES)})`),
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
 * Runtime's `SessionStore` adapter (ADR-0005, Task 7.3). One row per transcript
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
		 * The Conversation epoch of the Durable acquisition or direct-response
		 * admission that mirrored this entry — provenance, not a fence. Resume stays
		 * pointer-driven and never consults it; it exists so "which authority grant
		 * wrote this transcript" is answerable when a dead Runtime invocation's
		 * transcript is newest. The column stays nullable for older entries.
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
 * Audit ledger for trusted document access performed by AgentCore: which
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
