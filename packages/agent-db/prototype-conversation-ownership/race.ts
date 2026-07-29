/**
 * PROTOTYPE — throwaway. §3.2 (and §3.1's second half): hammer admission against
 * Claim on the same Conversation and assert every admitted Run lands in exactly
 * one snapshot — never lost, never double-served.
 *
 * The load-bearing claim: admission takes `conversations FOR UPDATE` then INSERTs
 * `runs`; the Claim takes the same row (via UPDATE / FOR UPDATE OF c) then SELECTs
 * `runs` in the same transaction. They serialize on that row, so a Run is either
 * inside the snapshot or deferred to the next Claim.
 *
 *   bun race.ts [--conversations N] [--admitters N] [--claimants N]
 *               [--ms N] [--lease-ms N] [--shape join|select_then_update|exists_min]
 *               [--chaos]
 *
 * --chaos uses a lease far shorter than a turn, so leases lapse mid-drain and a
 * second worker claims while the first is still serving. That is where the epoch
 * fence has to earn its keep.
 */
import type pg from "pg";
import { applyPrototypeDdl, pool, resetData, withTx } from "./db";
import {
	admitRun,
	type Claim,
	type ClaimShape,
	claimConversation,
	fencedAppend,
	type RunRef,
	releaseConversation,
	snapshotRuns,
	startRun,
	terminalizeRun,
} from "./ownership";

const arg = (name: string, fallback: string) => {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);

const CHAOS = flag("chaos");
const CONVERSATIONS = Number(arg("conversations", "1"));
const ADMITTERS = Number(arg("admitters", "4"));
const CLAIMANTS = Number(arg("claimants", "4"));
const DURATION_MS = Number(arg("ms", "5000"));
const LEASE_MS = Number(arg("lease-ms", CHAOS ? "60" : "30000"));
const SHAPE = arg("shape", "join") as ClaimShape;
/** `same-tx` is ADR-0015's shape. `after-commit` takes the snapshot in a fresh
 * statement once the lease is already committed — used to find out which of
 * snapshot drain's properties actually depend on sharing the transaction. */
const SNAPSHOT = arg("snapshot", "same-tx") as "same-tx" | "after-commit";
/** Artificial delay between claim-commit and snapshot in `after-commit` mode. */
const GAP_MS = Number(arg("gap-ms", "1"));
const FENCED_WRITES = 4; // stand-in for a turn's ~15-20, kept small for volume

// ---------------------------------------------------------------------------

interface SnapshotRecord {
	worker: string;
	conversationId: string;
	epoch: number;
	runIds: string[];
	/** Runs in this snapshot that were admitted AFTER this Claim took the lease.
	 * Serialization on the `conversations` row is supposed to make this zero. */
	admittedAfterClaim: number;
}

/**
 * Admission-commit order, taken client-side. Postgres `now()` is TRANSACTION
 * start time, not statement time, so `runs.created_at` vs `conversations
 * .owner_until` cannot decide "was this Run admitted after the lease was
 * taken" — both skew earlier. Admitters and claimants share one event loop, so
 * `performance.now()` readings here are totally ordered and do decide it.
 */
const admitCommittedAt = new Map<string, number>();
let unknownAdmitOrder = 0;

const admitted: string[] = [];
const snapshots: SnapshotRecord[] = [];
const successfulStarts = new Map<string, string[]>(); // runId -> ["w1@epoch3"]
const successfulTerminals = new Map<string, string[]>();
const rejections = { lease: 0, status: 0, gone: 0 };
let claimAttempts = 0;
let claimEmpty = 0;
/** Empty claim while a Conversation was genuinely claimable — i.e. the candidate
 * scan SKIP LOCKED past a row an admission held FOR UPDATE. This is the real
 * starvation number; "empty while some Run was queued" is not, because a
 * Conversation another worker legitimately owns is correctly invisible. */
let claimYieldedToAdmission = 0;
let admitFailures = 0;

const p = pool(ADMITTERS + CLAIMANTS + 4);
const setup = await p.connect();
await applyPrototypeDdl(setup);
await resetData(setup, { conversations: CONVERSATIONS });
setup.release();

let running = true;
let seq = 0;

async function admitter(id: number) {
	const conn = await p.connect();
	try {
		while (running) {
			const runId = `r-${id}-${seq++}`;
			const conversationId = `c${1 + (seq % CONVERSATIONS)}`;
			try {
				await withTx(conn, () =>
					admitRun(conn, {
						userId: "u1",
						conversationId,
						runId,
						message: `msg ${runId}`,
					}),
				);
				admitted.push(runId);
				admitCommittedAt.set(runId, performance.now());
			} catch {
				admitFailures++;
			}
			await Bun.sleep(1);
		}
	} finally {
		conn.release();
	}
}

async function claimant(id: number) {
	const workerId = `w${id}`;
	const conn = await p.connect();
	try {
		while (running) {
			claimAttempts++;
			let claim: Claim | null = null;
			let runs: RunRef[] = [];
			let claimCommittedAt = 0;
			await conn.query("begin");
			try {
				claim = await claimConversation(conn, {
					workerId,
					leaseMs: LEASE_MS,
					shape: SHAPE,
				});
				// The snapshot shares the Claim's transaction on purpose: the lease
				// UPDATE holds the conversations row lock that admission must take.
				if (claim && SNAPSHOT === "same-tx")
					runs = await snapshotRuns(conn, claim);
				await conn.query("commit");
				claimCommittedAt = performance.now();
				if (claim && SNAPSHOT === "after-commit") {
					await Bun.sleep(GAP_MS); // window admission can slip through
					runs = await snapshotRuns(conn, claim);
				}
			} catch (error) {
				await conn.query("rollback").catch(() => {});
				throw error;
			}

			if (!claim) {
				claimEmpty++;
				if (await claimableConversationExists(conn)) claimYieldedToAdmission++;
				await Bun.sleep(2);
				continue;
			}

			snapshots.push({
				worker: workerId,
				conversationId: claim.conversationId,
				epoch: claim.epoch,
				runIds: runs.map((r) => r.runId),
				admittedAfterClaim: runs.filter((r) => {
					const at = admitCommittedAt.get(r.runId);
					if (at === undefined) {
						unknownAdmitOrder++;
						return false;
					}
					return at > claimCommittedAt;
				}).length,
			});

			const lostLease = await drain(conn, workerId, claim, runs);
			// ADR-0015: a lost lease means halt and abandon — do NOT release, the
			// successor owns the Conversation now.
			if (!lostLease) await releaseConversation(conn, claim);
		}
	} finally {
		conn.release();
	}
}

/** Serve the snapshot one Run at a time. Returns true if the lease was lost. */
async function drain(
	conn: pg.PoolClient,
	workerId: string,
	claim: Claim,
	runs: RunRef[],
): Promise<boolean> {
	for (const { runId } of runs) {
		const started = await startRun(conn, {
			runId,
			workerId,
			epoch: claim.epoch,
		});
		if (!started.ok) {
			rejections[started.rejected]++;
			if (started.rejected === "lease") return true;
			continue; // status rejection: went terminal under us, next Run
		}
		record(successfulStarts, runId, `${workerId}@${claim.epoch}`);

		for (let i = 0; i < FENCED_WRITES; i++) {
			const appended = await fencedAppend(conn, {
				runId,
				fenceValue: claim.epoch,
			});
			if (!appended.ok) {
				rejections[appended.rejected]++;
				if (appended.rejected === "lease") return true;
				break;
			}
		}

		const terminal = await terminalizeRun(conn, {
			runId,
			epoch: claim.epoch,
			status: "done",
		});
		if (!terminal.ok) {
			rejections[terminal.rejected]++;
			if (terminal.rejected === "lease") return true;
			continue;
		}
		record(successfulTerminals, runId, `${workerId}@${claim.epoch}`);
	}
	return false;
}

function record(m: Map<string, string[]>, key: string, value: string) {
	const existing = m.get(key);
	if (existing) existing.push(value);
	else m.set(key, [value]);
}

async function queuedRunsExist(conn: pg.PoolClient): Promise<boolean> {
	const { rows } = await conn.query(
		"select 1 from runs where status = 'queued' limit 1",
	);
	return rows.length > 0;
}

/** The Claim's own predicate, minus the row lock. If this is true right after an
 * empty claim, the candidate scan skipped a locked row rather than finding
 * nothing to do. */
async function claimableConversationExists(
	conn: pg.PoolClient,
): Promise<boolean> {
	const { rows } = await conn.query(
		`select 1 from conversations c
		  where (c.owner_until is null or c.owner_until <= now())
		    and exists (select 1 from runs r
		                 where r.user_id = c.user_id
		                   and r.conversation_id = c.conversation_id
		                   and r.status = 'queued')
		  limit 1`,
	);
	return rows.length > 0;
}

// ---------------------------------------------------------------------------

console.log(
	`shape=${SHAPE} conversations=${CONVERSATIONS} admitters=${ADMITTERS} ` +
		`claimants=${CLAIMANTS} lease=${LEASE_MS}ms chaos=${CHAOS} for ${DURATION_MS}ms`,
);

const workers = [
	...Array.from({ length: ADMITTERS }, (_, i) => admitter(i)),
	...Array.from({ length: CLAIMANTS }, (_, i) => claimant(i)),
];
await Bun.sleep(DURATION_MS);
running = false;
await Promise.allSettled(workers);

// Quiescent final drain: no admitters, long lease, one claimant, until empty.
const finalConn = await p.connect();
for (let i = 0; i < 200; i++) {
	if (!(await queuedRunsExist(finalConn))) break;
	await finalConn.query("begin");
	const claim = await claimConversation(finalConn, {
		workerId: "w-final",
		leaseMs: 60_000,
		shape: SHAPE,
	});
	const runs = claim ? await snapshotRuns(finalConn, claim) : [];
	await finalConn.query("commit");
	if (!claim) {
		await Bun.sleep(20);
		continue;
	}
	snapshots.push({
		worker: "w-final",
		conversationId: claim.conversationId,
		epoch: claim.epoch,
		runIds: runs.map((r) => r.runId),
		admittedAfterClaim: 0,
	});
	const lost = await drain(finalConn, "w-final", claim, runs);
	if (!lost) await releaseConversation(finalConn, claim);
}

const { rows: finalStates } = await finalConn.query<{
	status: string;
	n: string;
}>("select status, count(*) as n from runs group by status order by status");
const { rows: epochRows } = await finalConn.query<{
	conversation_id: string;
	epoch: number;
	owner_until: Date | null;
}>("select conversation_id, epoch, owner_until from conversations order by 1");
finalConn.release();
await p.end();

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

const snapshotOwner = new Map<string, SnapshotRecord[]>();
for (const s of snapshots) {
	for (const runId of s.runIds) record2(snapshotOwner, runId, s);
}
function record2(
	m: Map<string, SnapshotRecord[]>,
	k: string,
	v: SnapshotRecord,
) {
	const e = m.get(k);
	if (e) e.push(v);
	else m.set(k, [v]);
}

const admittedSet = new Set(admitted);
const neverSnapshotted = [...admittedSet].filter((r) => !snapshotOwner.has(r));
const multiSnapshotted = [...snapshotOwner.entries()].filter(
	([, s]) => s.length > 1,
);
const doubleStarted = [...successfulStarts.entries()].filter(
	([, s]) => s.length > 1,
);
const doubleTerminalized = [...successfulTerminals.entries()].filter(
	([, s]) => s.length > 1,
);
const neverTerminalized = [...admittedSet].filter(
	(r) => !successfulTerminals.has(r),
);
const drainLengths = snapshots.map((s) => s.runIds.length);
const maxDrain = drainLengths.length ? Math.max(...drainLengths) : 0;
const nonEmptyDrains = drainLengths.filter((n) => n > 0);

const p2 = (n: number, d: number) =>
	d === 0 ? "—" : `${((n / d) * 100).toFixed(1)}%`;

console.log(`
admitted                 ${admitted.length}  (${admitFailures} failed)
claims taken             ${snapshots.length}
claim attempts           ${claimAttempts}  (${claimEmpty} empty; ${claimYieldedToAdmission} of those had a claimable Conversation = ${p2(claimYieldedToAdmission, claimAttempts)} skipped a locked row)
snapshot size            max ${maxDrain}, mean ${
	nonEmptyDrains.length
		? (
				nonEmptyDrains.reduce((a, b) => a + b, 0) / nonEmptyDrains.length
			).toFixed(2)
		: 0
} over ${nonEmptyDrains.length} non-empty
served-after-claimed     ${snapshots.reduce((a, s) => a + s.admittedAfterClaim, 0)} Run(s) whose admission committed AFTER their Claim committed, yet inside its snapshot (${unknownAdmitOrder} unordered)
fence rejections         lease=${rejections.lease} status=${rejections.status} gone=${rejections.gone}
final run states         ${finalStates.map((r) => `${r.status}=${r.n}`).join(" ") || "(none)"}
epochs                   ${epochRows.map((r) => `${r.conversation_id}:${r.epoch}${r.owner_until ? "(held)" : ""}`).join(" ")}
`);

const strict = !CHAOS;
const checks: [string, boolean, string][] = [
	[
		"never double-served (no Run started twice under the fence)",
		doubleStarted.length === 0,
		doubleStarted
			.slice(0, 5)
			.map(([r, s]) => `${r} by ${s.join(", ")}`)
			.join(" | "),
	],
	[
		"never double-terminalized",
		doubleTerminalized.length === 0,
		doubleTerminalized
			.slice(0, 5)
			.map(([r, s]) => `${r} by ${s.join(", ")}`)
			.join(" | "),
	],
	[
		"never lost (every admitted Run reached some snapshot)",
		neverSnapshotted.length === 0,
		`${neverSnapshotted.length} missing: ${neverSnapshotted.slice(0, 5).join(", ")}`,
	],
];
if (strict) {
	checks.push([
		"each Run in exactly one snapshot",
		multiSnapshotted.length === 0,
		multiSnapshotted
			.slice(0, 5)
			.map(
				([r, s]) =>
					`${r} in ${s.map((x) => `${x.worker}@${x.epoch}`).join(", ")}`,
			)
			.join(" | "),
	]);
	checks.push([
		"every admitted Run reached done",
		neverTerminalized.length === 0,
		`${neverTerminalized.length} unfinished: ${neverTerminalized.slice(0, 5).join(", ")}`,
	]);
}

let failed = 0;
for (const [name, ok, detail] of checks) {
	console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}`);
	if (!ok) {
		failed++;
		console.log(`        ${detail}`);
	}
}
if (CHAOS) {
	console.log(
		`\n  (chaos) re-snapshotted after a lapsed lease: ${multiSnapshotted.length} Run(s); ` +
			`stranded non-terminal: ${neverTerminalized.length} — Reclamation's job, not the snapshot's`,
	);
}
console.log(
	failed === 0 ? "\nALL CHECKS PASSED\n" : `\n${failed} CHECK(S) FAILED\n`,
);
process.exit(failed === 0 ? 0 : 1);
