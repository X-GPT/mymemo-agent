// SPIKE — THROWAWAY (Task 4.1: E2B semantics gate). See README.md.
// Runs seven live proofs against real E2B with the pinned SDK. Do not import
// from production code and do not import this from production code.

import { Sandbox } from "e2b";

const TEMPLATE = Bun.env.E2B_SPIKE_TEMPLATE ?? "base";
const MARKER = { spike: "e2b-semantics" } as const;
const FILE_PATH = "/home/user/spike-proof.txt";
const FILE_CONTENT = `spike-proof ${crypto.randomUUID()}`;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;

type Verdict = "pass" | "fail" | "inconclusive";
type Evidence = (line: string) => void;
type Proof = {
	id: string;
	title: string;
	run: (evidence: Evidence) => Promise<Verdict>;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pollUntil<T>(
	label: string,
	evidence: Evidence,
	intervalMs: number,
	maxMs: number,
	probe: () => Promise<T | undefined>,
): Promise<{ value: T; elapsedMs: number } | undefined> {
	const start = Date.now();
	while (Date.now() - start < maxMs) {
		const value = await probe();
		if (value !== undefined) {
			const elapsedMs = Date.now() - start;
			evidence(`${label}: satisfied after ${(elapsedMs / 1000).toFixed(1)}s`);
			return { value, elapsedMs };
		}
		await sleep(intervalMs);
	}
	evidence(`${label}: NOT satisfied within ${maxMs / 1000}s`);
	return undefined;
}

async function killQuietly(sandboxId: string) {
	try {
		await Sandbox.kill(sandboxId);
	} catch {
		// already gone
	}
}

async function psSurvivors(sandbox: Sandbox): Promise<string[]> {
	const res = await sandbox.commands.run(
		"ps -eo pid,ppid,stat,args | grep 'sleep 300' | grep -v grep || true",
	);
	return res.stdout
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
}

// ---------------------------------------------------------------------------

const p1PauseOnTimeout: Proof = {
	id: "p1",
	title: "pause-on-timeout preserves files",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 20_000,
			lifecycle: { onTimeout: "pause" },
			metadata: { ...MARKER },
		});
		try {
			evidence(
				`created ${sandbox.sandboxId} timeoutMs=20000 lifecycle.onTimeout=pause`,
			);
			await sandbox.files.write(FILE_PATH, FILE_CONTENT);
			const info = await Sandbox.getInfo(sandbox.sandboxId);
			evidence(
				`lifecycle reported by getInfo: ${JSON.stringify(info.lifecycle)}`,
			);

			const paused = await pollUntil(
				"state becomes 'paused' after timeout",
				evidence,
				5_000,
				240_000,
				async () => {
					const i = await Sandbox.getInfo(sandbox.sandboxId);
					return i.state === "paused" ? i : undefined;
				},
			);
			if (!paused) return "fail";

			const resumed = await Sandbox.connect(sandbox.sandboxId, {
				timeoutMs: 60_000,
			});
			const readBack = await resumed.files.read(FILE_PATH);
			evidence(
				`file after auto-pause+connect: ${readBack === FILE_CONTENT ? "intact" : `CORRUPT (${readBack})`}`,
			);
			return readBack === FILE_CONTENT ? "pass" : "fail";
		} finally {
			await killQuietly(sandbox.sandboxId);
		}
	},
};

const p2ExplicitPauseReconnect: Proof = {
	id: "p2",
	title: "paused sandbox can reconnect/resume",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 120_000,
			metadata: { ...MARKER },
		});
		try {
			await sandbox.files.write(FILE_PATH, FILE_CONTENT);
			const pausedNow = await sandbox.pause();
			evidence(`sandbox.pause() -> ${pausedNow}`);
			const infoPaused = await Sandbox.getInfo(sandbox.sandboxId);
			evidence(`state after pause: ${infoPaused.state}`);
			if (infoPaused.state !== "paused") return "fail";

			const start = Date.now();
			const resumed = await Sandbox.connect(sandbox.sandboxId, {
				timeoutMs: 60_000,
			});
			evidence(`Sandbox.connect resumed in ${Date.now() - start}ms`);
			const infoResumed = await Sandbox.getInfo(sandbox.sandboxId);
			evidence(
				`state after connect: ${infoResumed.state}, isRunning=${await resumed.isRunning()}`,
			);
			const readBack = await resumed.files.read(FILE_PATH);
			evidence(
				`file after pause+connect: ${readBack === FILE_CONTENT ? "intact" : "CORRUPT"}`,
			);
			return infoResumed.state === "running" && readBack === FILE_CONTENT
				? "pass"
				: "fail";
		} finally {
			await killQuietly(sandbox.sandboxId);
		}
	},
};

const p3ExtendTimeout: Proof = {
	id: "p3",
	title: "active timeout can be extended",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 60_000,
			metadata: { ...MARKER },
		});
		try {
			const e1 = (await Sandbox.getInfo(sandbox.sandboxId)).endAt.getTime();
			await sandbox.setTimeout(300_000);
			const e2 = (await Sandbox.getInfo(sandbox.sandboxId)).endAt.getTime();
			evidence(
				`setTimeout(300000) moved endAt by ${((e2 - e1) / 1000).toFixed(1)}s (${e2 > e1 ? "extended" : "NOT extended"})`,
			);

			// connect with a SHORTER timeout must not shrink the deadline
			await Sandbox.connect(sandbox.sandboxId, { timeoutMs: 30_000 });
			const e3 = (await Sandbox.getInfo(sandbox.sandboxId)).endAt.getTime();
			evidence(
				`connect(timeoutMs=30000) after that: endAt ${e3 >= e2 ? "unchanged/longer (no shrink)" : `SHRANK by ${((e2 - e3) / 1000).toFixed(1)}s`}`,
			);

			// setTimeout CAN shrink (documented) — record it so the worker renewal loop knows
			await sandbox.setTimeout(45_000);
			const e4 = (await Sandbox.getInfo(sandbox.sandboxId)).endAt.getTime();
			evidence(
				`setTimeout(45000) after that: endAt ${e4 < e3 ? "shrank (setTimeout is absolute, can reduce)" : "did not shrink"}`,
			);

			return e2 > e1 && e3 >= e2 ? "pass" : "fail";
		} finally {
			await killQuietly(sandbox.sandboxId);
		}
	},
};

// p4/p5 share the snapshot; run() of p5 reads this
let sharedSnapshotId: string | undefined;
let sharedSourceSandboxId: string | undefined;

const p4Snapshot: Proof = {
	id: "p4",
	title: "snapshot creation returns a reusable checkpoint id",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 180_000,
			metadata: { ...MARKER },
		});
		sharedSourceSandboxId = sandbox.sandboxId;
		await sandbox.files.write(FILE_PATH, FILE_CONTENT);

		const start = Date.now();
		const snap = await sandbox.createSnapshot();
		const durationMs = Date.now() - start;
		evidence(
			`createSnapshot() -> ${JSON.stringify(snap)} in ${(durationMs / 1000).toFixed(1)}s`,
		);
		sharedSnapshotId = snap.snapshotId;

		// design-relevant: what state is the SOURCE sandbox in after checkpoint?
		const infoAfter = await Sandbox.getInfo(sandbox.sandboxId);
		evidence(`source sandbox state after createSnapshot: ${infoAfter.state}`);
		if (infoAfter.state === "paused") {
			const resumed = await Sandbox.connect(sandbox.sandboxId, {
				timeoutMs: 60_000,
			});
			const readBack = await resumed.files.read(FILE_PATH);
			evidence(
				`source resumable after checkpoint: yes, file ${readBack === FILE_CONTENT ? "intact" : "CORRUPT"}`,
			);
		}
		return snap.snapshotId ? "pass" : "fail";
	},
};

const p5RestoreFromSnapshot: Proof = {
	id: "p5",
	title:
		"fresh sandbox restores from checkpoint (snapshot survives source kill)",
	async run(evidence) {
		if (!sharedSnapshotId || !sharedSourceSandboxId) {
			evidence("p4 did not run or failed; no snapshot to restore from");
			return "inconclusive";
		}
		// kill the source FIRST so a successful restore also proves persistence
		await killQuietly(sharedSourceSandboxId);
		evidence(`killed source sandbox ${sharedSourceSandboxId} before restore`);

		const restored = await Sandbox.create(sharedSnapshotId, {
			timeoutMs: 60_000,
			metadata: { ...MARKER },
		});
		try {
			evidence(
				`Sandbox.create(${sharedSnapshotId}) -> ${restored.sandboxId} (new id: ${restored.sandboxId !== sharedSourceSandboxId})`,
			);
			const readBack = await restored.files.read(FILE_PATH);
			evidence(
				`file in restored sandbox: ${readBack === FILE_CONTENT ? "intact" : "CORRUPT"}`,
			);
			return readBack === FILE_CONTENT &&
				restored.sandboxId !== sharedSourceSandboxId
				? "pass"
				: "fail";
		} finally {
			await killQuietly(restored.sandboxId);
			const deleted = await Sandbox.deleteSnapshot(sharedSnapshotId).catch(
				() => false,
			);
			evidence(`deleteSnapshot(${sharedSnapshotId}) -> ${deleted}`);
		}
	},
};

const p6CommandTreeCleanup: Proof = {
	id: "p6",
	title:
		"command timeout/cancel cleanup handles descendants (or wrapper needed)",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 180_000,
			metadata: { ...MARKER },
		});
		try {
			// Case A: foreground command hits timeoutMs while a backgrounded child runs
			try {
				await sandbox.commands.run("bash -c 'sleep 300 & wait'", {
					timeoutMs: 5_000,
				});
				evidence("case A: command unexpectedly completed within timeout");
			} catch (err) {
				evidence(
					`case A: timeout raised ${err instanceof Error ? `${err.constructor.name}: ${err.message.slice(0, 120)}` : String(err)}`,
				);
			}
			await sleep(1_000);
			const survivorsA = await psSurvivors(sandbox);
			evidence(
				`case A survivors after timeout: ${survivorsA.length === 0 ? "none" : survivorsA.join(" | ")}`,
			);
			// -x matches the process name exactly, so pkill can't match its own shell wrapper
			if (survivorsA.length > 0)
				await sandbox.commands.run("pkill -x sleep || true");

			// Case B: explicit kill of a background command with a descendant
			const handle = await sandbox.commands.run("bash -c 'sleep 300 & wait'", {
				background: true,
			});
			await sleep(1_000);
			const killed = await sandbox.commands.kill(handle.pid);
			evidence(`case B: commands.kill(${handle.pid}) -> ${killed}`);
			await sleep(1_000);
			const survivorsB = await psSurvivors(sandbox);
			evidence(
				`case B survivors after kill: ${survivorsB.length === 0 ? "none" : survivorsB.join(" | ")}`,
			);

			const wrapperNeeded = survivorsA.length > 0 || survivorsB.length > 0;
			evidence(
				`verdict: sandbox-side process-group wrapper ${wrapperNeeded ? "IS REQUIRED" : "not required"} before enabling Bash`,
			);
			// the proof "passes" when it produces a definite answer either way
			return "pass";
		} finally {
			await killQuietly(sandbox.sandboxId);
		}
	},
};

const p7CostModelEvidence: Proof = {
	id: "p7",
	title: "paused sandbox vs snapshot are distinct objects at rest",
	async run(evidence) {
		const sandbox = await Sandbox.create(TEMPLATE, {
			timeoutMs: 120_000,
			metadata: { ...MARKER },
		});
		let snapshotId: string | undefined;
		try {
			await sandbox.files.write(FILE_PATH, FILE_CONTENT);
			const snap = await sandbox.createSnapshot();
			snapshotId = snap.snapshotId;
			await Sandbox.connect(sandbox.sandboxId, { timeoutMs: 60_000 });
			await sandbox.pause();

			// both objects visible at rest, through different list surfaces
			const paginator = Sandbox.list({ query: { state: ["paused"] } });
			const pausedIds: string[] = [];
			while (paginator.hasNext) {
				for (const s of await paginator.nextItems())
					pausedIds.push(s.sandboxId);
			}
			evidence(
				`paused-sandbox list contains ours: ${pausedIds.includes(sandbox.sandboxId)}`,
			);

			const snapPaginator = Sandbox.listSnapshots({
				sandboxId: sandbox.sandboxId,
			});
			const snapIds: string[] = [];
			while (snapPaginator.hasNext) {
				for (const s of await snapPaginator.nextItems())
					snapIds.push(s.snapshotId);
			}
			evidence(`snapshot list for this sandbox: ${JSON.stringify(snapIds)}`);

			// snapshot survives killing the paused sandbox — distinct lifetimes
			await Sandbox.kill(sandbox.sandboxId);
			const snapAfterKill = Sandbox.listSnapshots({
				sandboxId: sandbox.sandboxId,
			});
			const survivingSnaps: string[] = [];
			while (snapAfterKill.hasNext) {
				for (const s of await snapAfterKill.nextItems())
					survivingSnaps.push(s.snapshotId);
			}
			evidence(
				`snapshots surviving sandbox kill: ${JSON.stringify(survivingSnaps)}`,
			);
			evidence("dollar cost at rest is a pricing-docs question -> NOTES.md");

			return pausedIds.includes(sandbox.sandboxId) && survivingSnaps.length > 0
				? "pass"
				: "fail";
		} finally {
			await killQuietly(sandbox.sandboxId);
			if (snapshotId) {
				try {
					const deleted = await Sandbox.deleteSnapshot(snapshotId);
					evidence(`deleteSnapshot(${snapshotId}) -> ${deleted}`);
				} catch (err) {
					evidence(
						`deleteSnapshot failed: ${err instanceof Error ? err.message : String(err)}`,
					);
				}
			}
		}
	},
};

// ---------------------------------------------------------------------------

async function cleanup() {
	console.log(bold("cleanup: sweeping spike-tagged sandboxes and snapshots"));
	const paginator = Sandbox.list({ query: { metadata: { ...MARKER } } });
	let sandboxCount = 0;
	while (paginator.hasNext) {
		for (const s of await paginator.nextItems()) {
			console.log(dim(`  kill ${s.sandboxId} (${s.state})`));
			await killQuietly(s.sandboxId);
			sandboxCount++;
		}
	}
	// shared p4 snapshot survives if p5 crashed before delete
	if (sharedSnapshotId)
		await Sandbox.deleteSnapshot(sharedSnapshotId).catch(() => {});
	console.log(`cleanup done: ${sandboxCount} sandbox(es) killed`);
}

const PROOFS: Proof[] = [
	p2ExplicitPauseReconnect,
	p3ExtendTimeout,
	p4Snapshot,
	p5RestoreFromSnapshot,
	p6CommandTreeCleanup,
	p7CostModelEvidence,
	p1PauseOnTimeout, // slowest last: idles a sandbox past its timeout
];

async function main() {
	if (!Bun.env.E2B_API_KEY) {
		console.error("E2B_API_KEY is required");
		process.exit(1);
	}
	const args = process.argv.slice(2);
	if (args.includes("cleanup")) {
		await cleanup();
		return;
	}
	const selected =
		args.length > 0 ? PROOFS.filter((p) => args.includes(p.id)) : PROOFS;
	if (selected.length === 0) {
		console.error(
			`unknown proof ids: ${args.join(" ")} (known: ${PROOFS.map((p) => p.id).join(" ")})`,
		);
		process.exit(1);
	}

	const sdkVersion = await import("e2b/package.json")
		.then((m) => m.default.version)
		.catch(() => "unknown");
	console.log(
		bold(`E2B semantics spike — template=${TEMPLATE}, sdk=e2b@${sdkVersion}`),
	);
	const results: Array<{ proof: Proof; verdict: Verdict; evidence: string[] }> =
		[];
	for (const proof of selected) {
		console.log(`\n${bold(`[${proof.id}] ${proof.title}`)}`);
		const evidenceLines: string[] = [];
		const evidence: Evidence = (line) => {
			evidenceLines.push(line);
			console.log(dim(`  ${line}`));
		};
		let verdict: Verdict;
		try {
			verdict = await proof.run(evidence);
		} catch (err) {
			evidence(
				`threw: ${err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err)}`,
			);
			verdict = "fail";
		}
		const paint =
			verdict === "pass" ? green : verdict === "fail" ? red : yellow;
		console.log(`  ${paint(verdict.toUpperCase())}`);
		results.push({ proof, verdict, evidence: evidenceLines });
	}

	console.log(`\n${bold("summary")}`);
	for (const { proof, verdict } of results) {
		const paint =
			verdict === "pass" ? green : verdict === "fail" ? red : yellow;
		console.log(`  ${paint(verdict.padEnd(12))} [${proof.id}] ${proof.title}`);
	}
	const failed = results.some((r) => r.verdict !== "pass");
	process.exit(failed ? 1 : 0);
}

await main();
