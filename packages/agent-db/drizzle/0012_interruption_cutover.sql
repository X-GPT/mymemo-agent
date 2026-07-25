ALTER TABLE "runs" RENAME COLUMN "cancel_requested_at" TO "interrupt_requested_at";--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_status_check";--> statement-breakpoint
DROP INDEX "runs_one_active_per_conversation";--> statement-breakpoint
DROP INDEX "runs_stale_recovery_idx";--> statement-breakpoint
DROP INDEX "runs_cleanup_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "runs_one_active_per_conversation" ON "runs" USING btree ("user_id","conversation_id") WHERE "runs"."status" in ('queued', 'running', 'interrupt_requested');--> statement-breakpoint
CREATE INDEX "runs_stale_recovery_idx" ON "runs" USING btree ("locked_until") WHERE "runs"."status" in ('running', 'interrupt_requested');--> statement-breakpoint
CREATE INDEX "runs_cleanup_idx" ON "runs" USING btree ("terminal_at") WHERE "runs"."status" in ('done', 'error', 'interrupted');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_status_check" CHECK ("runs"."status" in ('queued', 'running', 'interrupt_requested', 'done', 'error', 'interrupted'));--> statement-breakpoint
DROP TRIGGER "runs_notify_queued" ON "runs";--> statement-breakpoint
DROP FUNCTION notify_run_queued();--> statement-breakpoint
CREATE FUNCTION notify_run_doorbell()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('run_doorbell', json_build_object('runId', NEW.run_id)::text);
	RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER runs_notify_queued
AFTER INSERT ON "runs"
FOR EACH ROW
WHEN (NEW.status = 'queued')
EXECUTE FUNCTION notify_run_doorbell();--> statement-breakpoint
CREATE TRIGGER runs_notify_interrupt_requested
AFTER UPDATE OF status ON "runs"
FOR EACH ROW
WHEN (OLD.status = 'running' AND NEW.status = 'interrupt_requested')
EXECUTE FUNCTION notify_run_doorbell();
