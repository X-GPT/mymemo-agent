ALTER TABLE "agent_sessions" ADD COLUMN "epoch" integer;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_worker_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "owner_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "executed_by_worker_id" text;--> statement-breakpoint
CREATE INDEX "conversations_reclamation_idx" ON "conversations" USING btree ("owner_until") WHERE "conversations"."owner_until" is not null;