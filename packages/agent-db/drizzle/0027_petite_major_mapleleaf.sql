CREATE TABLE "conversation_messages" (
	"sequence" bigserial NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"parts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "conversation_messages_user_id_conversation_id_message_id_pk" PRIMARY KEY("user_id","conversation_id","message_id"),
	CONSTRAINT "conversation_messages_sequence_unique" UNIQUE("sequence"),
	CONSTRAINT "conversation_messages_role_check" CHECK ("conversation_messages"."role" in ('user', 'assistant'))
);
--> statement-breakpoint
ALTER TABLE "conversation_messages" ADD CONSTRAINT "conversation_messages_conversation_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."conversations"("user_id","conversation_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "conversation_messages_order_idx" ON "conversation_messages" USING btree ("user_id","conversation_id","sequence");