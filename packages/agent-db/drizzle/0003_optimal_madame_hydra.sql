ALTER TABLE "conversation_runtime" DROP CONSTRAINT "conversation_runtime_checkpoint_status_check";--> statement-breakpoint
ALTER TABLE "conversation_runtime" DROP COLUMN "latest_snapshot_id";--> statement-breakpoint
ALTER TABLE "conversation_runtime" DROP COLUMN "previous_snapshot_id";--> statement-breakpoint
ALTER TABLE "conversation_runtime" DROP COLUMN "workspace_checkpoint_status";