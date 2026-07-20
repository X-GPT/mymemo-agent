ALTER TABLE "runs" ADD COLUMN "normalized_input" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "live_stream_failed_at" timestamp with time zone;