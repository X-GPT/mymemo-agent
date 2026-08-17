DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "conversations"
		WHERE "execution_lane" = 'agentcore_canary'
	) THEN
		RAISE EXCEPTION 'execution-runtime cutover refused while agentcore_canary Conversations exist';
	END IF;
END;
$$;--> statement-breakpoint
ALTER TABLE "execution_lane_deployments" RENAME TO "execution_runtime_deployments";--> statement-breakpoint
ALTER TABLE "conversations" RENAME COLUMN "execution_lane" TO "execution_runtime";--> statement-breakpoint
ALTER TABLE "execution_runtime_deployments" RENAME COLUMN "execution_lane" TO "execution_runtime";--> statement-breakpoint
ALTER TABLE "execution_runtime_deployments" RENAME COLUMN "lane_aware" TO "runtime_aware";--> statement-breakpoint
CREATE OR REPLACE FUNCTION notify_run_doorbell()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM conversations c
		WHERE c.user_id = NEW.user_id
			AND c.conversation_id = NEW.conversation_id
			AND c.execution_runtime = 'fargate'
	) THEN
		PERFORM pg_notify('run_doorbell', json_build_object('runId', NEW.run_id)::text);
	END IF;
	RETURN NEW;
END;
$$;--> statement-breakpoint
ALTER TABLE "conversations" DROP CONSTRAINT "conversations_execution_lane_check";--> statement-breakpoint
ALTER TABLE "execution_runtime_deployments" DROP CONSTRAINT "execution_lane_deployments_lane_check";--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_execution_runtime_check" CHECK ("conversations"."execution_runtime" in ('fargate', 'agentcore'));--> statement-breakpoint
ALTER TABLE "execution_runtime_deployments" ADD CONSTRAINT "execution_runtime_deployments_runtime_check" CHECK ("execution_runtime_deployments"."execution_runtime" = 'fargate');
