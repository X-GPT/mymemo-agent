CREATE TABLE "agentcore_dispatch_outbox" (
	"run_id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"publish_claimed_by" text,
	"publish_claim_until" timestamp with time zone,
	"publish_attempts" integer DEFAULT 0 NOT NULL,
	"replay_requested_at" timestamp with time zone,
	"replay_requested_by" text
);
--> statement-breakpoint
DROP TABLE "canary_campaigns" CASCADE;--> statement-breakpoint
DROP TABLE "canary_dispatch_outbox" CASCADE;--> statement-breakpoint
CREATE INDEX "agentcore_dispatch_outbox_pending_idx" ON "agentcore_dispatch_outbox" USING btree ("admitted_at") WHERE "agentcore_dispatch_outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "agentcore_dispatch_outbox_publish_claim_idx" ON "agentcore_dispatch_outbox" USING btree ("publish_claim_until");