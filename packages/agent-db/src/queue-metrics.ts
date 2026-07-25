import { sql } from "drizzle-orm";
import type { Database } from "./client";
import { runs } from "./schema";

export interface RunQueueMetrics {
	queuedRuns: number;
	runningRuns: number;
}

/**
 * Read the Postgres-backed run queue depth used by the worker scaler. Running
 * capacity includes live `interrupt_requested` runs because the owning worker
 * still has cleanup/terminalization work to do until the lock expires.
 */
export async function readRunQueueMetrics(
	db: Database,
): Promise<RunQueueMetrics> {
	const [row] = await db
		.select({
			queuedRuns: sql<number>`coalesce(count(*) filter (
				where ${runs.status} = 'queued'
			), 0)::int`,
			runningRuns: sql<number>`coalesce(count(*) filter (
				where ${runs.status} in ('running', 'interrupt_requested')
				and ${runs.lockedUntil} > now()
			), 0)::int`,
		})
		.from(runs)
		.where(sql`${runs.createdAt} > now() - interval '1 day'`);

	return {
		queuedRuns: Number(row?.queuedRuns ?? 0),
		runningRuns: Number(row?.runningRuns ?? 0),
	};
}
