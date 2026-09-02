CREATE TABLE "conversation_vm" (
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"microvm_id" text,
	"endpoint" text,
	"image_version" text,
	"state" text NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checkpoint_pointer" text,
	CONSTRAINT "conversation_vm_user_id_conversation_id_pk" PRIMARY KEY("user_id","conversation_id"),
	CONSTRAINT "conversation_vm_state_check" CHECK ("conversation_vm"."state" in ('launching', 'running', 'terminated'))
);
--> statement-breakpoint
ALTER TABLE "conversation_vm" ADD CONSTRAINT "conversation_vm_conversation_fk" FOREIGN KEY ("user_id","conversation_id") REFERENCES "public"."conversations"("user_id","conversation_id") ON DELETE cascade ON UPDATE no action;