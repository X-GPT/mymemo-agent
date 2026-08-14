ALTER TABLE "canary_campaigns" ADD COLUMN "provisional_verdict" text;--> statement-breakpoint
ALTER TABLE "canary_campaigns" ADD COLUMN "cleanup_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD COLUMN "publish_claimed_by" text;--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD COLUMN "publish_claim_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD COLUMN "publish_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD COLUMN "replay_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD COLUMN "replay_requested_by" text;--> statement-breakpoint
CREATE INDEX "canary_dispatch_outbox_publish_claim_idx" ON "canary_dispatch_outbox" USING btree ("publish_claim_until");--> statement-breakpoint
ALTER TABLE "canary_campaigns" ADD CONSTRAINT "canary_campaigns_provisional_verdict_check" CHECK ("canary_campaigns"."provisional_verdict" is null or "canary_campaigns"."provisional_verdict" in ('pass_for_rollout_review', 'fail', 'inconclusive'));