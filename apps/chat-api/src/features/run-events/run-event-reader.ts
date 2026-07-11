import { and, asc, eq, gt } from "drizzle-orm";
import type { Database } from "@/db/client";
import { runEvents } from "@/db/schema";

/** One recorded run event, as the projector reads it back from `run_events`. */
export interface RunEventRow {
	seq: number;
	type: string;
	/** The jsonb payload; shape depends on `type` and is validated on projection. */
	payload: unknown;
}

/**
 * Reads a run's durable events after a sequence cursor. The projector calls this
 * on every loop turn — the durable table is the source of truth, so a replay
 * from the `Last-Event-ID` cursor and a live tail are the same query.
 */
export interface RunEventReader {
	/** Events for `runId` with `seq > afterSeq`, ordered by ascending `seq`. */
	read(runId: string, afterSeq: number, limit: number): Promise<RunEventRow[]>;
}

/** Drizzle adapter over `run_events`. The composite PK `(run_id, seq)` is the
 * replay index this query rides. */
export class DrizzleRunEventReader implements RunEventReader {
	constructor(private readonly db: Database) {}

	async read(
		runId: string,
		afterSeq: number,
		limit: number,
	): Promise<RunEventRow[]> {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("Run event read limit must be a positive integer");
		}
		const query = this.db
			.select({
				seq: runEvents.seq,
				type: runEvents.type,
				payload: runEvents.payload,
			})
			.from(runEvents)
			.where(and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq)))
			.orderBy(asc(runEvents.seq));

		return query.limit(limit);
	}
}
