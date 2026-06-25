-- `IF NOT EXISTS` is hand-added (drizzle-kit does not emit it): `sandbox_leases`
-- may already exist on a mymemo_agent DB provisioned by the pre-Drizzle init.sql
-- (its shape is identical), so a baseline run must not abort here. Keep on regen.
CREATE TABLE IF NOT EXISTS "conversations" (
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
CREATE TABLE IF NOT EXISTS "sandbox_leases" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_leases_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
