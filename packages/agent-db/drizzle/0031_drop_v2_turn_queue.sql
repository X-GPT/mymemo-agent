ALTER TABLE "conversation_vm" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "conversation_vm" CASCADE;--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP CONSTRAINT "conversation_messages_turn_status_check";--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP COLUMN "started_at";--> statement-breakpoint
ALTER TABLE "conversation_messages" DROP COLUMN "finished_at";