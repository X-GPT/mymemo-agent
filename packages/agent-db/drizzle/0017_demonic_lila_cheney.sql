DROP INDEX "runs_stale_recovery_idx";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "locked_by";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "locked_until";--> statement-breakpoint
ALTER TABLE "runs" DROP COLUMN "heartbeat_at";