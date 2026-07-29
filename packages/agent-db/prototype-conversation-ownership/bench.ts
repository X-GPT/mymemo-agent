/**
 * PROTOTYPE — throwaway. §3.3: does the per-fenced-write `conversations` probe
 * interfere with the Claim/release writes on the same row?
 *
 * A/B on one variable. Both arms do identical work — claim, start, N fenced
 * appends, terminalize, release. Only the append's fence predicate differs:
 *
 *   epoch  — ADR-0015: EXISTS probe on the conversations PK (non-locking)
 *   lease  — today:    r.locked_by = $me AND r.locked_until > now(), no probe
 *
 * If the probe interfered, the epoch arm's tail latency would separate from the
 * lease arm's as worker count rises — and the Claim/release writes, which DO
 * take the row lock, would slow down too.
 *
 *   bun bench.ts [--conversations N] [--writes N] [--workers 1,8,32]
 */
import type pg from "pg";
import { applyPrototypeDdl, pool, resetData, withTx } from "./db";
import {
	admitRun,
	claimConversation,
	type FenceKind,
	fencedAppend,
	releaseConversation,
	snapshotRuns,
	startRun,
	terminalizeRun,
} from "./ownership";

const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};

const CONVERSATIONS = Number(arg("conversations", "400"));
const WRITES_PER_TURN = Number(arg("writes", "18")); // ADR-0015's "15-20"
const WORKER_COUNTS = arg("workers", "1,8,32").split(",").map(Number);
/** Background admitters, the THIRD writer of `conversations`: each takes the row
 * FOR UPDATE and bumps `last_activity_at` while an owner is doing fenced reads
 * of that same row. This is the "hottest row" concern, tested directly.
 * Rate-capped: admitting faster than the drain just grows the queue forever and
 * the measurement never terminates. */
const ADMITTERS = Number(arg("admitters", "0"));
const ADMIT_GAP_MS = Number(arg("admit-gap-ms", "25"));
/** Run the arms in the other order. The first arm always gets a freshly seeded,
 * freshly ANALYZEd table; without checking both orders an order effect reads as
 * a fence-cost difference. */
const FLIP = process.argv.includes("--flip");
const LEASE_MS = 60_000;

const samples = {
	fence: [] as number[],
	claim: [] as number[],
	release: [] as number[],
};

function pct(xs: number[], q: number): number {
	if (xs.length === 0) return Number.NaN;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor(q * s.length))] ?? Number.NaN;
}

async function timed<T>(bucket: number[], fn: () => Promise<T>): Promise<T> {
	const t0 = performance.now();
	try {
		return await fn();
	} finally {
		bucket.push(performance.now() - t0);
	}
}

const p = pool(Math.max(...WORKER_COUNTS) + 4);

async function seed(conn: pg.PoolClient) {
	await resetData(conn, { conversations: CONVERSATIONS });
	await conn.query(
		`insert into runs (run_id, user_id, conversation_id, status, next_event_seq)
		 select 'r-' || c.conversation_id, c.user_id, c.conversation_id, 'queued', 2
		   from conversations c`,
	);
	await conn.query("analyze conversations");
	await conn.query("analyze runs");
}

/** One worker: claim -> start -> N fenced appends -> terminalize -> release. */
async function worker(id: number, fence: FenceKind, done: () => boolean) {
	const workerId = `w${id}`;
	const conn = await p.connect();
	try {
		while (!done()) {
			await conn.query("begin");
			const claim = await timed(samples.claim, () =>
				claimConversation(conn, { workerId, leaseMs: LEASE_MS, shape: "join" }),
			);
			const runs = claim ? await snapshotRuns(conn, claim) : [];
			await conn.query("commit");
			if (!claim) return;

			for (const { runId } of runs) {
				const started = await startRun(conn, {
					runId,
					workerId,
					epoch: claim.epoch,
					alsoSetRunLease: fence === "run_lease",
				});
				if (!started.ok) continue;
				for (let i = 0; i < WRITES_PER_TURN; i++) {
					await timed(samples.fence, () =>
						fencedAppend(conn, {
							runId,
							fenceValue: fence === "run_lease" ? workerId : claim.epoch,
							fenceKind: fence,
						}),
					);
				}
				await terminalizeRun(conn, {
					runId,
					epoch: claim.epoch,
					status: "done",
				});
			}
			await timed(samples.release, () => releaseConversation(conn, claim));
		}
	} finally {
		conn.release();
	}
}

async function run(fence: FenceKind, workers: number) {
	const setup = await p.connect();
	await seed(setup);

	samples.fence.length = 0;
	samples.claim.length = 0;
	samples.release.length = 0;

	let remaining = CONVERSATIONS;
	const done = () => remaining-- <= 0;

	let admitting = true;
	const admitters = Array.from({ length: ADMITTERS }, async (_, i) => {
		const conn = await p.connect();
		let n = 0;
		try {
			while (admitting) {
				const c = 1 + (n % CONVERSATIONS);
				await withTx(conn, () =>
					admitRun(conn, {
						userId: "u1",
						conversationId: `c${c}`,
						runId: `adm-${fence}-${workers}-${i}-${n++}`,
						message: "bench",
					}),
				).catch(() => {});
				await Bun.sleep(ADMIT_GAP_MS);
			}
		} finally {
			conn.release();
		}
	});

	const t0 = performance.now();
	await Promise.all(
		Array.from({ length: workers }, (_, i) => worker(i, fence, done)),
	);
	const elapsed = performance.now() - t0;
	admitting = false;
	await Promise.allSettled(admitters);

	const { rows } = await setup.query<{ n: string }>(
		"select count(*) as n from runs where status = 'done'",
	);
	setup.release();

	return {
		fence,
		workers,
		elapsed,
		served: Number(rows[0]?.n ?? 0),
		fenceP50: pct(samples.fence, 0.5),
		fenceP95: pct(samples.fence, 0.95),
		fenceP99: pct(samples.fence, 0.99),
		fenceN: samples.fence.length,
		claimP50: pct(samples.claim, 0.5),
		claimP95: pct(samples.claim, 0.95),
		releaseP95: pct(samples.release, 0.95),
	};
}

const setupConn = await p.connect();
await applyPrototypeDdl(setupConn);
setupConn.release();

const ms = (n: number) =>
	Number.isNaN(n) ? "   —  " : n.toFixed(3).padStart(6);

console.log(
	`\n${CONVERSATIONS} conversations x 1 Run x ${WRITES_PER_TURN} fenced writes per turn` +
		`, ${ADMITTERS} background admitter(s) writing the same rows\n`,
);
console.log(
	"fence   workers   turns/s   fence p50   p95     p99      claim p50   p95      release p95",
);
console.log("-".repeat(94));

for (const workers of WORKER_COUNTS) {
	const arms: FenceKind[] = FLIP
		? ["run_lease", "conversation_epoch"]
		: ["conversation_epoch", "run_lease"];
	for (const fence of arms) {
		const r = await run(fence, workers);
		const label = fence === "conversation_epoch" ? "epoch" : "lease";
		console.log(
			`${label.padEnd(7)} ${String(workers).padStart(7)}   ` +
				`${((r.served / r.elapsed) * 1000).toFixed(0).padStart(7)}   ` +
				`${ms(r.fenceP50)}ms ${ms(r.fenceP95)}ms ${ms(r.fenceP99)}ms   ` +
				`${ms(r.claimP50)}ms ${ms(r.claimP95)}ms   ${ms(r.releaseP95)}ms`,
		);
	}
}

await p.end();
console.log();
