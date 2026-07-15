CREATE TABLE "conversation_artifacts" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"path" text NOT NULL,
	"object_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"content_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_artifacts_size_bytes_check" CHECK ("conversation_artifacts"."size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "conversation_artifacts" ADD CONSTRAINT "conversation_artifacts_conversation_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."conversations"("user_id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_artifacts_owner_conversation_path_idx" ON "conversation_artifacts" USING btree ("user_id","conversation_id","path");