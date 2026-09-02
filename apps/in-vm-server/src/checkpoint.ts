import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * The Checkpoint (spec #654, ticket #670): the Agent session (`~/.claude`)
 * and the Workspace as one gzipped tar, exchanged with chat-api's
 * `/v2/checkpoint/<conversation>` door under the gateway token (why a door
 * and not S3: ADR-0034, amendment 2026-09-02). `save` runs inside the
 * suspend hook once the drain loop is parked; `restore` inside the run hook
 * before the boot sweep. Both fail loudly: a Checkpoint that did not land
 * must fail its hook rather than let the VM claim durability it lacks.
 *
 * The archive is two roots — `.claude` relative to HOME and the Workspace
 * relative to its parent — so the layout survives a Workspace outside HOME
 * (local runs) without renaming members.
 */

export interface CheckpointPaths {
	/** The runtime user's HOME: `.claude` under it is the Agent session. */
	homeDir: string;
	workspaceDir: string;
}

export interface CheckpointDoor {
	/** chat-api's `/v2/checkpoint/<conversation>` as the VM reaches it. */
	url: string;
	/** The per-Conversation gateway token. */
	token: string;
	/** This VM's id — chat-api refuses a Checkpoint from a retired VM. */
	microvmId: string;
}

export interface CheckpointLogger {
	info(payload: object, message?: string): void;
}

/**
 * CLI scratch under `.claude` that no resume reads. Everything else — the
 * transcripts under `projects/`, todos, settings state — is the session.
 */
const CLAUDE_EXCLUDES = [".claude/debug", ".claude/shell-snapshots"];

/** Well inside the platform's 60 s hook cap, leaving room for the drain. */
const TRANSFER_TIMEOUT_MS = 45_000;

async function tar(args: string[]): Promise<void> {
	const proc = Bun.spawn(["tar", ...args], {
		stdout: "ignore",
		stderr: "pipe",
	});
	const [stderr, exitCode] = await Promise.all([
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`tar ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
	}
}

/** Pack the session and Workspace and PUT them through the door. */
export async function saveCheckpoint(
	paths: CheckpointPaths,
	door: CheckpointDoor,
	logger: CheckpointLogger,
): Promise<void> {
	const started = Date.now();
	// Always a member, so restore never has to ask whether it is there.
	mkdirSync(path.join(paths.homeDir, ".claude"), { recursive: true });
	const dir = await mkdtemp(path.join(tmpdir(), "checkpoint-"));
	try {
		const file = path.join(dir, "checkpoint.tar.gz");
		await tar([
			"-czf",
			file,
			...CLAUDE_EXCLUDES.map((pattern) => `--exclude=${pattern}`),
			"-C",
			paths.homeDir,
			".claude",
			"-C",
			path.dirname(paths.workspaceDir),
			path.basename(paths.workspaceDir),
		]);
		const archive = Bun.file(file);
		const response = await fetch(door.url, {
			method: "PUT",
			headers: {
				authorization: `Bearer ${door.token}`,
				"x-mymemo-microvm-id": door.microvmId,
				"content-type": "application/gzip",
			},
			body: archive,
			signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
		});
		if (!response.ok) {
			throw new Error(`checkpoint PUT answered ${response.status}`);
		}
		logger.info(
			{ bytes: archive.size, elapsedMs: Date.now() - started },
			"checkpoint saved",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

/**
 * GET the Conversation's latest Checkpoint and unpack it in place. "none"
 * means chat-api holds nothing for this Conversation (a fresh one).
 */
export async function restoreCheckpoint(
	paths: CheckpointPaths,
	door: CheckpointDoor,
	logger: CheckpointLogger,
): Promise<"restored" | "none"> {
	const started = Date.now();
	const response = await fetch(door.url, {
		headers: { authorization: `Bearer ${door.token}` },
		signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
	});
	if (response.status === 204) return "none";
	if (!response.ok) {
		throw new Error(`checkpoint GET answered ${response.status}`);
	}
	const dir = await mkdtemp(path.join(tmpdir(), "checkpoint-"));
	try {
		const file = path.join(dir, "checkpoint.tar.gz");
		const bytes = await Bun.write(file, response);
		mkdirSync(paths.homeDir, { recursive: true });
		mkdirSync(path.dirname(paths.workspaceDir), { recursive: true });
		// One pass per root: portable across GNU and BSD tar, which disagree on
		// positional -C during extraction.
		await tar(["-xzf", file, "-C", paths.homeDir, ".claude"]);
		await tar([
			"-xzf",
			file,
			"-C",
			path.dirname(paths.workspaceDir),
			path.basename(paths.workspaceDir),
		]);
		logger.info(
			{ bytes, elapsedMs: Date.now() - started },
			"checkpoint restored",
		);
		return "restored";
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}
