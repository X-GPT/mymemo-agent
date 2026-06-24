CREATE TABLE "conversations" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"scope" text NOT NULL,
	"collection_id" text,
	"summary_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversations_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
--> statement-breakpoint
CREATE TABLE "sandbox_leases" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"sandbox_id" text NOT NULL,
	"agent_session_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_leases_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id")
);
