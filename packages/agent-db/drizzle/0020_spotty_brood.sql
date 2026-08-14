CREATE TABLE "canary_campaigns" (
	"campaign_id" text PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"campaign_version" text NOT NULL,
	"fixture_version" text NOT NULL,
	"fixture_checksum" text NOT NULL,
	"input_checksum" text NOT NULL,
	"model" text NOT NULL,
	"scenario_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"message_id" text NOT NULL,
	"lifecycle" text DEFAULT 'preparing' NOT NULL,
	"verdict" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '30 days' NOT NULL,
	CONSTRAINT "canary_campaigns_lifecycle_check" CHECK ("canary_campaigns"."lifecycle" in ('preparing', 'provisioning', 'running', 'cleaning', 'complete')),
	CONSTRAINT "canary_campaigns_verdict_check" CHECK ("canary_campaigns"."verdict" is null or "canary_campaigns"."verdict" in ('pass_for_rollout_review', 'fail', 'inconclusive')),
	CONSTRAINT "canary_campaigns_complete_verdict_check" CHECK (("canary_campaigns"."lifecycle" = 'complete') = ("canary_campaigns"."verdict" is not null))
);
--> statement-breakpoint
CREATE TABLE "canary_dispatch_outbox" (
	"dispatch_id" text PRIMARY KEY NOT NULL,
	"campaign_id" text NOT NULL,
	"scenario_id" text NOT NULL,
	"user_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"run_id" text NOT NULL,
	"execution_lane" text NOT NULL,
	"admitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "canary_dispatch_outbox_lane_check" CHECK ("canary_dispatch_outbox"."execution_lane" = 'agentcore_canary')
);
--> statement-breakpoint
ALTER TABLE "canary_dispatch_outbox" ADD CONSTRAINT "canary_dispatch_outbox_campaign_id_canary_campaigns_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."canary_campaigns"("campaign_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "canary_campaigns_idempotency_key_idx" ON "canary_campaigns" USING btree ("idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "canary_campaigns_one_active_idx" ON "canary_campaigns" USING btree ((true)) WHERE "canary_campaigns"."lifecycle" <> 'complete';--> statement-breakpoint
CREATE INDEX "canary_campaigns_expiry_idx" ON "canary_campaigns" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "canary_dispatch_outbox_run_idx" ON "canary_dispatch_outbox" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canary_dispatch_outbox_campaign_scenario_idx" ON "canary_dispatch_outbox" USING btree ("campaign_id","scenario_id");--> statement-breakpoint
CREATE INDEX "canary_dispatch_outbox_pending_idx" ON "canary_dispatch_outbox" USING btree ("admitted_at") WHERE "canary_dispatch_outbox"."published_at" is null;--> statement-breakpoint
CREATE INDEX "canary_dispatch_outbox_expiry_idx" ON "canary_dispatch_outbox" USING btree ("expires_at");
