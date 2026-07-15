CREATE TABLE "artifact_objects" (
	"object_key" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"path" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"committed_at" timestamp with time zone,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "artifact_objects_status_check" CHECK ("artifact_objects"."status" in ('pending', 'current', 'superseded'))
);
--> statement-breakpoint
CREATE INDEX "artifact_objects_run_idx" ON "artifact_objects" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "artifact_objects_status_idx" ON "artifact_objects" USING btree ("status");