ALTER TABLE "conversations" ADD COLUMN "execution_lane" text DEFAULT 'fargate' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_execution_lane_check" CHECK ("conversations"."execution_lane" in ('fargate', 'agentcore_canary'));--> statement-breakpoint
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
			AND c.execution_lane = 'fargate'
	) THEN
		PERFORM pg_notify('run_doorbell', json_build_object('runId', NEW.run_id)::text);
	END IF;
	RETURN NEW;
END;
$$;
