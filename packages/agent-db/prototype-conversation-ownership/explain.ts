/**
 * PROTOTYPE — throwaway. §3.1 first half: is `FOR UPDATE OF c SKIP LOCKED` legal
 * in the Claim's join shape, and does it plan sanely?
 *
 * Prints, per candidate shape and per data scale: the server version, whether
 * the statement parses/executes at all, and the plan — specifically where the
 * LockRows node sits relative to Sort, which decides whether SKIP LOCKED skips
 * in queue order or in scan order.
 */

import { applyPrototypeDdl, client, resetData } from "./db";
import { CLAIM_SHAPES, claimSql } from "./ownership";

const SCALES = [
	{ conversations: 5, runsPer: 2 },
	{ conversations: 2000, runsPer: 3 },
];

const c = client();
await c.connect();
await applyPrototypeDdl(c);

const { rows: version } = await c.query<{ v: string }>("select version() as v");
console.log(`\n${version[0]?.v}\n`);

for (const scale of SCALES) {
	await resetData(c, { conversations: scale.conversations });
	await c.query(
		`insert into runs (run_id, user_id, conversation_id, status, next_event_seq, created_at)
		 select 'r-' || c.conversation_id || '-' || g, c.user_id, c.conversation_id,
		        'queued', 2, now() - (random() * interval '1 hour')
		   from conversations c, generate_series(1, $1) g`,
		[scale.runsPer],
	);
	await c.query("analyze conversations");
	await c.query("analyze runs");

	console.log(
		`${"=".repeat(72)}\nscale: ${scale.conversations} conversations x ${scale.runsPer} queued runs\n${"=".repeat(72)}`,
	);

	for (const shape of CLAIM_SHAPES) {
		console.log(`\n--- shape: ${shape} ---`);
		const sql = claimSql(shape);
		try {
			await c.query("begin");
			const plan = await c.query<{ "QUERY PLAN": string }>(
				`explain (analyze, buffers, costs off, timing off) ${sql}`,
				shape === "select_then_update" ? [] : ["w-explain", 60_000],
			);
			await c.query("rollback");
			console.log(plan.rows.map((r) => r["QUERY PLAN"]).join("\n"));
		} catch (error) {
			await c.query("rollback").catch(() => {});
			console.log(`REJECTED: ${(error as Error).message}`);
			continue;
		}

		// And actually run it, so "it planned" is not mistaken for "it works".
		try {
			await c.query("begin");
			const claimed = await c.query(
				sql,
				shape === "select_then_update" ? [] : ["w-explain", 60_000],
			);
			await c.query("rollback");
			console.log(
				`executes: ${claimed.rowCount} row(s)` +
					(shape === "select_then_update" ? " (candidate select only)" : ""),
			);
		} catch (error) {
			await c.query("rollback").catch(() => {});
			console.log(`EXECUTION FAILED: ${(error as Error).message}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Head-of-queue skew: the `join` shape walks `runs` in GLOBAL created_at order
// and probes `conversations` per row, so every queued Run belonging to an
// already-owned Conversation is a row the candidate scan must walk past. This is
// the one real cost the winning plan carries; measure it rather than assume it.
// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(72)}\nhead-of-queue skew\n${"=".repeat(72)}`);

for (const headDepth of [1, 100, 1000, 5000]) {
	await resetData(c, { conversations: 2 });
	// c1 holds the oldest `headDepth` queued Runs and is already owned.
	await c.query(
		`insert into runs (run_id, user_id, conversation_id, status, next_event_seq, created_at)
		 select 'head-' || g, 'u1', 'c1', 'queued', 2, now() - interval '2 hours' + (g * interval '1 ms')
		   from generate_series(1, $1) g`,
		[headDepth],
	);
	// c2 has a single, newer queued Run — the only claimable candidate.
	await c.query(
		`insert into runs (run_id, user_id, conversation_id, status, next_event_seq, created_at)
		 values ('tail-1', 'u1', 'c2', 'queued', 2, now())`,
	);
	await c.query(
		`update conversations set owner_worker_id = 'other', owner_until = now() + interval '5 minutes', epoch = 1
		  where conversation_id = 'c1'`,
	);
	await c.query("analyze runs");
	await c.query("analyze conversations");

	await c.query("begin");
	const plan = await c.query<{ "QUERY PLAN": string }>(
		`explain (analyze, buffers, costs off, timing off) ${claimSql("join")}`,
		["w-skew", 60_000],
	);
	await c.query("rollback");
	const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
	const scanned =
		/Index Scan using runs_queue_claim_idx on runs r \(actual rows=(\d+)/.exec(
			text,
		);
	const buffers = /^\s*Buffers: shared hit=(\d+)/m.exec(text);
	const time = /Execution Time: ([\d.]+) ms/.exec(text);
	console.log(
		`head depth ${String(headDepth).padStart(5)}  ->  runs rows walked ${String(scanned?.[1] ?? "?").padStart(5)}` +
			`   buffers ${String(buffers?.[1] ?? "?").padStart(5)}   ${time?.[1] ?? "?"} ms`,
	);
}

await c.end();
