CREATE TABLE "conversations" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"scope" text NOT NULL,
	"collection_id" text,
	"summary_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "conversations_scope_check" CHECK ("conversations"."scope" in ('general', 'collection', 'document'))
);
--> statement-breakpoint
CREATE TABLE "document_access_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scope_type" text NOT NULL,
	"scope_id" text,
	"query" text,
	"document_ids" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_access_events_scope_type_check" CHECK ("document_access_events"."scope_type" in ('general', 'collection', 'document'))
);
--> statement-breakpoint
CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq")
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"run_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"status" text NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"heartbeat_at" timestamp with time zone,
	"cancel_requested_at" timestamp with time zone,
	"next_event_seq" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'cancel_requested', 'done', 'error', 'canceled'))
);
--> statement-breakpoint
CREATE TABLE "sandbox_leases" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"owner_id" text,
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"sandbox_id" text,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_leases_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_access_events_run_id_idx" ON "document_access_events" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "document_access_events_created_at_idx" ON "document_access_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_conversation" ON "runs" USING btree ("user_id","conversation_id") WHERE "runs"."status" in ('queued', 'running', 'cancel_requested');--> statement-breakpoint
CREATE INDEX "runs_queue_claim_idx" ON "runs" USING btree ("created_at") WHERE "runs"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "runs_stale_recovery_idx" ON "runs" USING btree ("locked_until") WHERE "runs"."status" in ('running', 'cancel_requested');--> statement-breakpoint
CREATE INDEX "runs_cleanup_idx" ON "runs" USING btree ("terminal_at") WHERE "runs"."status" in ('done', 'error', 'canceled');