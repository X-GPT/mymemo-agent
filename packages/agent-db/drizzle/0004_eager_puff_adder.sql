ALTER TABLE "document_access_events" ADD COLUMN "operation" text;--> statement-breakpoint
UPDATE "document_access_events"
SET "operation" = CASE WHEN "query" IS NULL THEN 'load' ELSE 'search' END;--> statement-breakpoint
ALTER TABLE "document_access_events" ALTER COLUMN "operation" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "document_access_events" ADD COLUMN "result_count" integer;--> statement-breakpoint
ALTER TABLE "document_access_events" ADD CONSTRAINT "document_access_events_operation_check" CHECK ("document_access_events"."operation" in ('search', 'list', 'load'));
