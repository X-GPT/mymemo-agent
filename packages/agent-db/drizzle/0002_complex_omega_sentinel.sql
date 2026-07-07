CREATE TABLE "agent_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"conversation_id" text NOT NULL,
	"project_key" text NOT NULL,
	"session_id" text NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"uuid" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversation_runtime" ADD COLUMN "agent_session_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_sessions_dedup_idx" ON "agent_sessions" USING btree ("conversation_id","session_id","subpath","uuid");--> statement-breakpoint
CREATE INDEX "agent_sessions_transcript_idx" ON "agent_sessions" USING btree ("conversation_id","session_id","subpath","id");--> statement-breakpoint
CREATE INDEX "agent_sessions_conversation_idx" ON "agent_sessions" USING btree ("conversation_id");