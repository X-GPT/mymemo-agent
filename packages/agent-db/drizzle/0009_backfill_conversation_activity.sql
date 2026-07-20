UPDATE "conversations" AS "conversation"
SET "last_activity_at" = COALESCE(
	(
		SELECT MAX("run"."created_at")
		FROM "runs" AS "run"
		WHERE "run"."user_id" = "conversation"."user_id"
			AND "run"."conversation_id" = "conversation"."conversation_id"
	),
	"conversation"."created_at"
);
