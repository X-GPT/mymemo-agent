import { resolveWorkspacePath } from "../file-tools/file-tools";
import type { RunBinding } from "../sandbox-env";

/**
 * Bounds on one Bash invocation. `systemMaxTimeoutMs` is the hard ceiling the
 * model can never exceed; the per-stream byte caps bound what the tool holds
 * and returns so a chatty command cannot blow up model context or memory.
 */
export interface BashToolLimits {
	systemMaxTimeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

export const DEFAULT_BASH_TOOL_LIMITS: BashToolLimits = {
	systemMaxTimeoutMs: 120_000,
	maxStdoutBytes: 65_536,
	maxStderrBytes: 65_536,
};

/** What the Runtime asks the sandbox to run as a managed, group-owned command. */
export interface ManagedCommandSpec {
	commandId: string;
	command: string;
	/** Absolute, workspace-rooted working directory. */
	cwd: string;
	/** Hard ceiling (already clamped). The sandbox impl uses it as a backstop. */
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
}

/** The normalized end state of a managed command. The sandbox impl converts
 * E2B's non-zero-exit and timeout throws into this shape rather than throwing. */
export interface RawCommandOutcome {
	/** `null` when the command was killed (cancel/timeout) before it exited. */
	exitCode: number | null;
	stdout: string;
	stderr: string;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
	/** The sandbox impl's own hard backstop fired. */
	timedOut: boolean;
}

/**
 * A running managed command. `outcome` resolves when the process ends (on its
 * own, or because `kill` felled its process group). `kill` and `reap` both act
 * on the whole process group — `kill` is the cancel/timeout path, `reap` is the
 * mandatory post-command cleanup that reports any survivors.
 */
export interface SandboxCommandSession {
	readonly outcome: Promise<RawCommandOutcome>;
	kill(): Promise<void>;
	reap(): Promise<{ survivors: number }>;
}

export interface SandboxCommandClient {
	start(spec: ManagedCommandSpec): SandboxCommandSession;
}

export type CommandOutcome = "completed" | "timeout" | "canceled" | "failed";

/**
 * One audit record for a command. Every command emits a `started` and a
 * `finished` event, each carrying the full run binding
 * (`{userId, conversationId, runId, sandboxId}`) so operators can attribute any
 * shell activity in the sandbox to the exact run that caused it. The handler
 * stays pure by emitting these to an injected sink; the SDK-loop wiring (M7)
 * persists them as durable `run_events` (internal, so the projector maps no
 * client frame — operators read them in the log, not the SSE stream).
 */
export interface CommandAuditEvent {
	phase: "started" | "finished";
	commandId: string;
	binding: RunBinding;
	command: string;
	cwd: string;
	timeoutMs: number;
	exitCode?: number | null;
	outcome?: CommandOutcome;
	cleanupOk?: boolean;
	stdoutTruncated?: boolean;
	stderrTruncated?: boolean;
}

export interface BashToolContext {
	client: SandboxCommandClient;
	workspaceRoot: string;
	binding: RunBinding;
	limits: BashToolLimits;
	/** Fires when the run is interrupted or ownership is lost; kills the command. */
	signal: AbortSignal;
	/**
	 * Records that this sandbox failed command-tree cleanup. The seam is wired to
	 * `conversation_runtime.sandbox_tainted`; provisioning never reuses a tainted
	 * sandbox (ADR-0007) — the next turn replaces it and orphan-records it.
	 */
	markSandboxTainted(reason: string): Promise<void>;
	recordCommandAudit(event: CommandAuditEvent): Promise<void>;
}

export interface BashToolInput {
	command: string;
	cwd?: string;
	timeoutMs?: number;
}

export interface BashToolResult {
	content: { type: "text"; text: string }[];
	isError?: true;
}

function toolText(payload: unknown): BashToolResult {
	return {
		content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
	};
}

function toolError(message: string): BashToolResult {
	return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Reject the obvious ways a command tries to detach from the foreground so it
 * outlives the tool call. The process-group wrapper already reaps normal
 * backgrounding (`cmd &`, `a & b`) when the command exits, but `nohup`,
 * `disown`, and `setsid` deliberately escape the group and would surface as
 * cleanup survivors — so we reject them up front with feedback the model can
 * act on, rather than letting them taint the sandbox. A bare trailing `&` is
 * rejected too: it signals a misunderstanding of Bash's foreground contract.
 */
function detectDetachedForm(command: string): string | undefined {
	if (/(^|[^&>])&\s*$/.test(command)) {
		return (
			"Bash runs commands in the foreground. Remove the trailing `&` — " +
			"background work is killed when the command returns."
		);
	}
	if (/\b(nohup|disown|setsid)\b/.test(command)) {
		return (
			"Bash runs commands in the foreground. `nohup`, `disown`, and `setsid` " +
			"are not allowed: the command and all its children must exit before the " +
			"tool returns."
		);
	}
	return undefined;
}

function clampTimeoutMs(
	requested: number | undefined,
	systemMaxMs: number,
): number {
	if (requested === undefined || !Number.isFinite(requested))
		return systemMaxMs;
	return Math.min(systemMaxMs, Math.max(1, Math.floor(requested)));
}

function boundUtf8(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	const encoder = new TextEncoder();
	let bytes = 0;
	let output = "";
	for (const char of text) {
		const nextBytes = encoder.encode(char).byteLength;
		if (bytes + nextBytes > maxBytes) return { text: output, truncated: true };
		bytes += nextBytes;
		output += char;
	}
	return { text: output, truncated: false };
}

function boundedErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.length > 240 ? `${message.slice(0, 237)}...` : message;
}

/**
 * Run one foreground shell command in the sandbox under the process-group
 * wrapper. All model-controlled shell execution goes through here; nothing runs
 * in the Runtime. The flow is: validate + clamp (before any sandbox call) → audit
 * `started` → start the managed command → race the command against the system
 * timeout and the run's cancel signal (either kills the process group) → reap
 * the group and, if anything survived, taint the sandbox and refuse a clean
 * result → audit `finished`.
 */
export async function runBashTool(
	input: BashToolInput,
	context: BashToolContext,
): Promise<BashToolResult> {
	const command = input.command?.trim();
	if (!command) return toolError("Bash requires a non-empty command.");

	const detached = detectDetachedForm(command);
	if (detached) return toolError(detached);

	const cwd = resolveWorkspacePath(input.cwd ?? ".", context.workspaceRoot);
	if (!cwd.ok) return toolError(cwd.error);

	const timeoutMs = clampTimeoutMs(
		input.timeoutMs,
		context.limits.systemMaxTimeoutMs,
	);
	const commandId = crypto.randomUUID();

	await context.recordCommandAudit({
		phase: "started",
		commandId,
		binding: context.binding,
		command,
		cwd: cwd.path.relativePath,
		timeoutMs,
	});

	const session = context.client.start({
		commandId,
		command,
		cwd: cwd.path.absolutePath,
		timeoutMs,
		maxStdoutBytes: context.limits.maxStdoutBytes,
		maxStderrBytes: context.limits.maxStderrBytes,
	});

	let canceled = false;
	let timedOut = false;
	let killError: unknown;
	let killCompletion: Promise<void> | undefined;
	const requestKill = (): void => {
		if (killCompletion) return;
		// Abort/timer callbacks cannot await. Attach the rejection handler now so
		// an E2B transport error cannot escape as an unhandled promise; the
		// mandatory reap below remains the proof that cleanup succeeded.
		killCompletion = session.kill().catch((error) => {
			killError = error;
		});
	};
	const onAbort = (): void => {
		canceled = true;
		requestKill();
	};
	if (context.signal.aborted) {
		canceled = true;
		requestKill();
	} else {
		context.signal.addEventListener("abort", onAbort, { once: true });
	}
	const timer = setTimeout(() => {
		timedOut = true;
		requestKill();
	}, timeoutMs);

	let raw: RawCommandOutcome | undefined;
	let runError: unknown;
	try {
		raw = await session.outcome;
	} catch (error) {
		runError = error;
	} finally {
		clearTimeout(timer);
		context.signal.removeEventListener("abort", onAbort);
	}
	await killCompletion;

	// Cleanup is mandatory and runs on every path, including a client failure: a
	// half-started process group must never outlive the tool call.
	let cleanupOk = true;
	let cleanupError: string | undefined;
	try {
		const { survivors } = await session.reap();
		if (survivors > 0) {
			cleanupOk = false;
			cleanupError = `${survivors} process(es) survived cleanup`;
		}
	} catch (error) {
		cleanupOk = false;
		cleanupError = boundedErrorMessage(error);
	}
	if (!cleanupOk && killError !== undefined) {
		cleanupError = `kill failed: ${boundedErrorMessage(killError)}; ${cleanupError}`;
	}

	const outcome: CommandOutcome = canceled
		? "canceled"
		: timedOut || raw?.timedOut
			? "timeout"
			: runError
				? "failed"
				: "completed";

	if (!cleanupOk) {
		await context.markSandboxTainted(
			`bash command ${commandId} cleanup failed: ${cleanupError}`,
		);
	}

	await context.recordCommandAudit({
		phase: "finished",
		commandId,
		binding: context.binding,
		command,
		cwd: cwd.path.relativePath,
		timeoutMs,
		exitCode: raw?.exitCode ?? null,
		outcome,
		cleanupOk,
		stdoutTruncated: raw?.stdoutTruncated ?? false,
		stderrTruncated: raw?.stderrTruncated ?? false,
	});

	if (!cleanupOk) {
		return toolError(
			"Bash cleanup failed; the sandbox is marked unhealthy and this run " +
				`cannot complete: ${cleanupError}`,
		);
	}
	if (!raw) {
		return toolError(`Bash failed: ${boundedErrorMessage(runError)}`);
	}

	const stdout = boundUtf8(raw.stdout, context.limits.maxStdoutBytes);
	const stderr = boundUtf8(raw.stderr, context.limits.maxStderrBytes);
	return toolText({
		exitCode: raw.exitCode,
		stdout: stdout.text,
		stderr: stderr.text,
		stdoutTruncated: raw.stdoutTruncated || stdout.truncated,
		stderrTruncated: raw.stderrTruncated || stderr.truncated,
		outcome,
	});
}
