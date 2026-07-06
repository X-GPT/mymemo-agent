CREATE TABLE "conversation_runtime" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sandbox_id" text,
	"sandbox_tainted" boolean DEFAULT false NOT NULL,
	"latest_snapshot_id" text,
	"previous_snapshot_id" text,
	"workspace_checkpoint_status" text DEFAULT 'clean' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_runtime_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "conversation_runtime_checkpoint_status_check" CHECK ("conversation_runtime"."workspace_checkpoint_status" in ('clean', 'dirty_uncheckpointed'))
);
--> statement-breakpoint
CREATE TABLE "orphan_sandboxes" (
	"sandbox_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"created_by_worker_id" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "sandbox_leases" CASCADE;