CREATE TABLE "run_events" (
	"run_id" text NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"visibility" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_run_id_seq_pk" PRIMARY KEY("run_id","seq"),
	CONSTRAINT "run_events_visibility_check" CHECK ("run_events"."visibility" in ('internal', 'client'))
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
	"fencing_token" bigint DEFAULT 0 NOT NULL,
	"next_event_seq" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"terminal_at" timestamp with time zone,
	CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'cancel_requested', 'done', 'error', 'canceled'))
);
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_id_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."runs"("run_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_conversation" ON "runs" USING btree ("user_id","conversation_id") WHERE "runs"."status" in ('queued', 'running', 'cancel_requested');