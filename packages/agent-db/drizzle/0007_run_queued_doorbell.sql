CREATE OR REPLACE FUNCTION notify_run_queued()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	PERFORM pg_notify('run_queued', json_build_object('runId', NEW.run_id)::text);
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER runs_notify_queued
AFTER INSERT ON "runs"
FOR EACH ROW
WHEN (NEW.status = 'queued')
EXECUTE FUNCTION notify_run_queued();
