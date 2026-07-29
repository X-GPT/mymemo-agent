/**
 * PROTOTYPE — throwaway. The hand-driven half.
 *
 * The harnesses (race.ts / bench.ts) answer the statistical questions. This
 * answers the ones you have to *see*: it holds real transactions open on
 * separate connections, so you can park an admission mid-transaction and watch
 * the Claim SKIP LOCKED past it, or freeze a worker mid-drain, expire its lease,
 * let another worker re-Claim, and then watch the first worker's fenced write
 * get rejected with a typed outcome.
 *
 * That interleaving is exactly what PGlite cannot express (single backend,
 * in-process) and what the ADR's epoch argument rests on.
 *
 *   bun tui.ts
 */
import type pg from "pg";
import { applyPrototypeDdl, client, resetData } from "./db";
import {
	admitRun,
	CLAIM_SHAPES,
	type Claim,
	type ClaimShape,
	claimConversation,
	type FenceOutcome,
	fencedAppend,
	type RunRef,
	releaseConversation,
	renewLease,
	snapshotRuns,
	startRun,
	terminalizeRun,
} from "./ownership";

const B = (s: string) => `\x1b[1m${s}\x1b[0m`;
const D = (s: string) => `\x1b[2m${s}\x1b[0m`;
const G = (s: string) => `\x1b[32m${s}\x1b[0m`;
const R = (s: string) => `\x1b[31m${s}\x1b[0m`;
const Y = (s: string) => `\x1b[33m${s}\x1b[0m`;

const LEASE_MS = 20_000;
const USER = "u1";

interface WorkerState {
	id: string;
	conn: pg.Client;
	claim: Claim | null;
	snapshot: RunRef[];
	cursor: number;
	txOpen: boolean;
	last: string;
}

const view = client();
const admitConn = client();
await view.connect();
await admitConn.connect();
await applyPrototypeDdl(view);

const workers: WorkerState[] = [];
for (const id of ["w1", "w2"]) {
	const conn = client();
	await conn.connect();
	workers.push({
		id,
		conn,
		claim: null,
		snapshot: [],
		cursor: 0,
		txOpen: false,
		last: "-",
	});
}

let focus = 0;
let shape: ClaimShape = "join";
let admitTxOpen = false;
let admitSeq = 0;
let message = "";

const focused = () => workers[focus] as WorkerState;

async function reset() {
	for (const w of workers) {
		if (w.txOpen) await w.conn.query("rollback").catch(() => {});
		w.claim = null;
		w.snapshot = [];
		w.cursor = 0;
		w.txOpen = false;
		w.last = "-";
	}
	if (admitTxOpen) await admitConn.query("rollback").catch(() => {});
	admitTxOpen = false;
	admitSeq = 0;
	await resetData(view, { conversations: 2 });
	message = "reset: 2 conversations, no runs";
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

function describe(outcome: FenceOutcome<unknown>): string {
	if (outcome.ok) return G("ok");
	if (outcome.rejected === "lease")
		return R(`rejected:lease (row epoch=${outcome.epoch})`);
	if (outcome.rejected === "status")
		return Y(`rejected:status (now ${outcome.current})`);
	return R("rejected:gone");
}

async function admit(conversationId: string, hold: boolean) {
	const runId = `r${++admitSeq}`;
	if (hold) {
		if (!admitTxOpen) {
			await admitConn.query("begin");
			admitTxOpen = true;
		}
		await admitRun(admitConn, {
			userId: USER,
			conversationId,
			runId,
			message: runId,
		});
		message = `admission tx OPEN, holding ${conversationId} FOR UPDATE (${runId} uncommitted)`;
		return;
	}
	await admitConn.query("begin");
	await admitRun(admitConn, {
		userId: USER,
		conversationId,
		runId,
		message: runId,
	});
	await admitConn.query("commit");
	message = `admitted ${runId} to ${conversationId}`;
}

async function claim(hold: boolean) {
	const w = focused();
	if (w.txOpen) {
		message = `${w.id} already has an open transaction`;
		return;
	}
	await w.conn.query("begin");
	w.txOpen = true;
	const c = await claimConversation(w.conn, {
		workerId: w.id,
		leaseMs: LEASE_MS,
		shape,
	});
	if (!c) {
		await w.conn.query("rollback");
		w.txOpen = false;
		message = `${w.id} claimed nothing (candidate scan found no unlocked, unowned Conversation with queued Runs)`;
		return;
	}
	w.claim = c;
	w.snapshot = await snapshotRuns(w.conn, c);
	w.cursor = 0;
	w.last = `claim ${c.conversationId}@${c.epoch}`;
	if (hold) {
		message = `${w.id} claim tx OPEN — ${c.conversationId}@${c.epoch}, snapshot ${w.snapshot.length} Run(s). Other worker's claim will SKIP LOCKED past it.`;
		return;
	}
	await w.conn.query("commit");
	w.txOpen = false;
	message = `${w.id} claimed ${c.conversationId}@${c.epoch}, snapshot ${w.snapshot.length} Run(s)`;
}

async function commitTx() {
	const w = focused();
	if (!w.txOpen) {
		message = `${w.id} has no open transaction`;
		return;
	}
	await w.conn.query("commit");
	w.txOpen = false;
	message = `${w.id} committed`;
}

async function serveNext() {
	const w = focused();
	if (!w.claim) {
		message = `${w.id} owns nothing`;
		return;
	}
	const next = w.snapshot[w.cursor];
	if (!next) {
		message = `${w.id} snapshot is drained (${w.snapshot.length} served)`;
		return;
	}
	const started = await startRun(w.conn, {
		runId: next.runId,
		workerId: w.id,
		epoch: w.claim.epoch,
	});
	if (!started.ok) {
		w.last = `start ${next.runId}: ${describe(started)}`;
		message =
			started.rejected === "lease"
				? `${w.id} LOST THE LEASE — halt and abandon, do NOT release`
				: `${w.id} skipping ${next.runId}: ${describe(started)}`;
		if (started.rejected !== "lease") w.cursor++;
		return;
	}
	const appended = await fencedAppend(w.conn, {
		runId: next.runId,
		fenceValue: w.claim.epoch,
	});
	const finished = appended.ok
		? await terminalizeRun(w.conn, {
				runId: next.runId,
				epoch: w.claim.epoch,
				status: "done",
			})
		: appended;
	w.cursor++;
	w.last = `serve ${next.runId}: ${describe(finished)}`;
	message = `${w.id} served ${next.runId} -> ${describe(finished)}`;
}

async function fenceProbe() {
	const w = focused();
	if (!w.claim) {
		message = `${w.id} owns nothing`;
		return;
	}
	const target = w.snapshot[Math.max(0, w.cursor - 1)] ?? w.snapshot[0];
	if (!target) {
		message = `${w.id} has no Run to write to`;
		return;
	}
	const outcome = await fencedAppend(w.conn, {
		runId: target.runId,
		fenceValue: w.claim.epoch,
	});
	w.last = `append ${target.runId}: ${describe(outcome)}`;
	message = `${w.id} fenced append on ${target.runId} -> ${describe(outcome)}`;
}

async function release() {
	const w = focused();
	if (!w.claim) {
		message = `${w.id} owns nothing`;
		return;
	}
	const ok = await releaseConversation(w.conn, w.claim);
	message = ok
		? `${w.id} released ${w.claim.conversationId}@${w.claim.epoch}`
		: `${w.id} release matched 0 rows — epoch ${w.claim.epoch} is no longer current`;
	w.claim = null;
	w.snapshot = [];
	w.cursor = 0;
}

async function heartbeat() {
	const w = focused();
	if (!w.claim) {
		message = `${w.id} owns nothing`;
		return;
	}
	const until = await renewLease(w.conn, w.claim, LEASE_MS);
	message = until
		? `${w.id} renewed to ${until.toISOString().slice(11, 19)}`
		: `${w.id} renew matched 0 rows — lease is gone (epoch superseded)`;
}

async function expireLease() {
	const w = focused();
	if (!w.claim) {
		message = `${w.id} owns nothing`;
		return;
	}
	await view.query(
		`update conversations set owner_until = now() - interval '1 second'
		  where user_id = $1 and conversation_id = $2`,
		[USER, w.claim.conversationId],
	);
	message = `expired ${w.claim.conversationId}'s lease — ${w.id} still believes it owns epoch ${w.claim.epoch}`;
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

async function render() {
	const { rows: convs } = await view.query<{
		conversation_id: string;
		epoch: number;
		owner_worker_id: string | null;
		owner_until: Date | null;
		live: boolean | null;
	}>(
		`select conversation_id, epoch, owner_worker_id, owner_until,
		        owner_until > now() as live
		   from conversations order by conversation_id`,
	);
	const { rows: runRows } = await view.query<{
		run_id: string;
		conversation_id: string;
		status: string;
		executed_by_worker_id: string | null;
	}>(
		`select run_id, conversation_id, status, executed_by_worker_id
		   from runs order by created_at, run_id`,
	);

	const lines: string[] = [];
	lines.push(
		B("Conversation-ownership prototype") +
			D(`   claim shape: ${shape}   lease: ${LEASE_MS / 1000}s`),
	);
	lines.push("");
	lines.push(B("CONVERSATIONS"));
	for (const c of convs) {
		const owner = c.owner_worker_id
			? c.live
				? G(`${c.owner_worker_id} live`)
				: R(`${c.owner_worker_id} LAPSED`)
			: D("unowned");
		lines.push(
			`  ${c.conversation_id}  epoch ${B(String(c.epoch))}  ${owner}` +
				D(
					c.owner_until
						? `  until ${c.owner_until.toISOString().slice(11, 19)}`
						: "",
				),
		);
	}

	lines.push("");
	lines.push(B("RUNS") + D(`  (${runRows.length})`));
	if (runRows.length === 0) lines.push(D("  none"));
	for (const r of runRows.slice(0, 12)) {
		const colour =
			r.status === "done"
				? G
				: r.status === "queued"
					? D
					: r.status === "running"
						? Y
						: R;
		lines.push(
			`  ${r.run_id.padEnd(5)} ${r.conversation_id}  ${colour(r.status.padEnd(9))}` +
				D(r.executed_by_worker_id ? `  by ${r.executed_by_worker_id}` : ""),
		);
	}
	if (runRows.length > 12) lines.push(D(`  ... ${runRows.length - 12} more`));

	lines.push("");
	lines.push(B("WORKERS"));
	for (const [i, w] of workers.entries()) {
		const marker = i === focus ? B("▸") : " ";
		const held = w.claim
			? `${w.claim.conversationId}@${B(String(w.claim.epoch))} snapshot[${w.cursor}/${w.snapshot.length}]`
			: D("idle");
		lines.push(
			`  ${marker} ${B(w.id)}  ${held}${w.txOpen ? R("  TX OPEN") : ""}`,
		);
		lines.push(D(`      last: ${w.last}`));
	}
	lines.push(
		`    ${admitTxOpen ? R("admission TX OPEN — holding a conversations row FOR UPDATE") : D("admission: idle")}`,
	);

	lines.push("");
	if (message) lines.push(`  ${message}`);
	lines.push("");
	lines.push(
		D("[1/2]") +
			" focus worker  " +
			D("[a/b]") +
			" admit to c1/c2  " +
			D("[A]") +
			" admit & HOLD tx  " +
			D("[x]") +
			" commit admission",
	);
	lines.push(
		D("[c]") +
			" claim+snapshot  " +
			D("[C]") +
			" claim & HOLD tx  " +
			D("[k]") +
			" commit worker tx  " +
			D("[s]") +
			" serve next Run",
	);
	lines.push(
		D("[f]") +
			" fenced append  " +
			D("[h]") +
			" heartbeat  " +
			D("[X]") +
			" expire lease  " +
			D("[e]") +
			" release  " +
			D("[t]") +
			" cycle shape",
	);
	lines.push(D("[r]") + " reset  " + D("[q]") + " quit");

	console.clear();
	console.log(lines.join("\n"));
}

// ---------------------------------------------------------------------------

const actions: Record<string, () => Promise<void>> = {
	"1": async () => {
		focus = 0;
	},
	"2": async () => {
		focus = 1;
	},
	a: () => admit("c1", false),
	b: () => admit("c2", false),
	A: () => admit("c1", true),
	x: async () => {
		if (!admitTxOpen) {
			message = "no open admission transaction";
			return;
		}
		await admitConn.query("commit");
		admitTxOpen = false;
		message = "admission committed — its Run is now visible to the next Claim";
	},
	c: () => claim(false),
	C: () => claim(true),
	k: commitTx,
	s: serveNext,
	f: fenceProbe,
	h: heartbeat,
	X: expireLease,
	e: release,
	t: async () => {
		const i = CLAIM_SHAPES.indexOf(shape);
		shape = CLAIM_SHAPES[(i + 1) % CLAIM_SHAPES.length] as ClaimShape;
		message = `claim shape: ${shape}`;
	},
	r: reset,
};

await reset();
await render();

const isTty = process.stdin.isTTY === true;
if (isTty) process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding("utf8");

outer: for await (const chunk of process.stdin) {
	// A TTY delivers one keystroke per chunk; a pipe delivers a whole line, so
	// `printf 'aacs' | bun tui.ts` drives the same loop for a smoke run.
	for (const key of String(chunk).replace(/[\r\n]/g, "")) {
		if (key === "q" || key === "\u0003") break outer;
		const action = actions[key];
		if (!action) continue;
		try {
			message = "";
			await action();
		} catch (error) {
			message = R(`error: ${(error as Error).message}`);
			const w = focused();
			if (w.txOpen) {
				await w.conn.query("rollback").catch(() => {});
				w.txOpen = false;
			}
		}
		await render();
	}
	if (!isTty) break;
}

if (isTty) process.stdin.setRawMode(false);
for (const w of workers) await w.conn.end();
await admitConn.end();
await view.end();
console.log("\nbye\n");
process.exit(0);
