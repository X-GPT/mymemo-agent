CREATE TABLE "execution_lane_deployments" (
	"execution_lane" text PRIMARY KEY DEFAULT 'fargate' NOT NULL,
	"lane_aware" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_lane_deployments_lane_check" CHECK ("execution_lane_deployments"."execution_lane" = 'fargate')
);
