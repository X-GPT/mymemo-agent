ALTER TABLE "conversations" DROP CONSTRAINT "conversations_execution_runtime_check";--> statement-breakpoint
ALTER TABLE "conversations" ALTER COLUMN "execution_runtime" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_execution_runtime_check" CHECK ("conversations"."execution_runtime" = 'agentcore');