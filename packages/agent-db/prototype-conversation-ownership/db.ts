/** PROTOTYPE — throwaway. Scratch-DB wiring for the ownership prototype. */
import pg from "pg";

export const PROTO_DATABASE_URL =
	process.env.PROTO_DATABASE_URL ??
	"postgresql://proto:proto@127.0.0.1:55432/prototype_ownership_wipe_me";

/** Keep timestamps as Date, ints as number — the prototype compares them. */
pg.types.setTypeParser(20, (v: string) => Number(v));

export function client(): pg.Client {
	return new pg.Client({ connectionString: PROTO_DATABASE_URL });
}

export function pool(max: number): pg.Pool {
	return new pg.Pool({ connectionString: PROTO_DATABASE_URL, max });
}

/**
 * The ADR-0015 schema delta, applied on top of the real migrations so the
 * prototype runs against the real table shapes, FKs and indexes.
 */
export const PROTOTYPE_DDL = `
alter table conversations
	add column if not exists owner_worker_id text,
	add column if not exists owner_until     timestamptz,
	add column if not exists epoch           integer not null default 0;

alter table runs
	add column if not exists executed_by_worker_id text;

-- ADR-0015 drops this: several queued Runs per Conversation is the point.
drop index if exists runs_one_active_per_conversation;

-- The index the Claim's candidate scan wants.
create index if not exists proto_runs_queued_by_conversation_idx
	on runs (user_id, conversation_id, created_at) where status = 'queued';
`;

export async function applyPrototypeDdl(c: pg.Client | pg.PoolClient) {
	await c.query(PROTOTYPE_DDL);
}

export async function resetData(
	c: pg.Client | pg.PoolClient,
	opts: { conversations: number; userId?: string },
) {
	const userId = opts.userId ?? "u1";
	await c.query("delete from run_events");
	await c.query("delete from runs");
	await c.query("delete from conversations");
	for (let i = 1; i <= opts.conversations; i++) {
		await c.query(
			`insert into conversations (user_id, conversation_id, scope, epoch)
			 values ($1, $2, 'general', 0)`,
			[userId, `c${i}`],
		);
	}
}

export async function withTx<T>(
	c: pg.Client | pg.PoolClient,
	fn: () => Promise<T>,
): Promise<T> {
	await c.query("begin");
	try {
		const out = await fn();
		await c.query("commit");
		return out;
	} catch (e) {
		await c.query("rollback").catch(() => {});
		throw e;
	}
}
