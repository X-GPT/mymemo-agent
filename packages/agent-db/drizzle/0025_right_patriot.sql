DROP TRIGGER "runs_notify_interrupt_requested" ON "runs";--> statement-breakpoint
DROP TRIGGER "runs_notify_queued" ON "runs";--> statement-breakpoint
DROP FUNCTION notify_run_doorbell();--> statement-breakpoint
ALTER TABLE "execution_runtime_deployments" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "execution_runtime_deployments" CASCADE;--> statement-breakpoint
DROP INDEX "runs_queue_claim_idx";
