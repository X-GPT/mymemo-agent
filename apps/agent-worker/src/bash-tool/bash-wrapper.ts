/**
 * The sandbox-side process-group wrapper for foreground Bash.
 *
 * The E2B semantics spike (Task 4.1, issue #173) proved that neither a command
 * `timeoutMs` expiry nor `commands.kill(pid)` cleans up a command's
 * descendants: a backgrounded child survives and reparents to init. So before
 * enabling Bash we must run every command as the leader of its own process
 * group and signal the whole group on timeout / cancel / stale-run recovery.
 *
 * This module produces three shell fragments the worker feeds to E2B:
 *  - {@link WRAPPER_PROGRAM} runs the user command as a fresh session leader
 *    (its own process group) and records the group id to a control file;
 *  - {@link buildKillGroupCommand} signals that group (TERM, grace, KILL);
 *  - {@link buildReapCommand} force-kills the group and reports how many
 *    processes survived, so a failed cleanup can taint the sandbox.
 *
 * The user command is passed only as an environment variable and reaches the
 * shell as a positional argument, never concatenated into shell text, so a
 * hostile command string cannot break out of the wrapper.
 */

/** Where per-command process-group id files live. Outside any workspace so the
 * agent's own Read/Grep/Glob never see them. */
export const DEFAULT_COMMAND_CONTROL_DIR = "/tmp/mymemo-commands";

/** Env var names the wrapper reads. Kept as constants so the JS side and the
 * shell side cannot drift. */
export const WRAPPER_ENV = {
	command: "MYMEMO_CMD",
	commandId: "MYMEMO_CMD_ID",
	controlDir: "MYMEMO_CONTROL_DIR",
} as const;

/** Absolute path of the control file holding one command's process-group id. */
export function controlFilePath(commandId: string, controlDir: string): string {
	return `${controlDir}/${commandId}.pgid`;
}

/**
 * The environment the wrapper needs. Passed to E2B `commands.run({ envs })` so
 * the user command travels as data, not as part of the executed shell text.
 */
export function wrapperEnv(input: {
	command: string;
	commandId: string;
	controlDir: string;
}): Record<string, string> {
	return {
		[WRAPPER_ENV.command]: input.command,
		[WRAPPER_ENV.commandId]: input.commandId,
		[WRAPPER_ENV.controlDir]: input.controlDir,
	};
}

/**
 * The wrapper program (POSIX sh; uses only setsid + coreutils so it runs under
 * dash or bash). It:
 *  1. starts the user command as a new session leader via `setsid`, so the
 *     command and every descendant share one process group;
 *  2. has that inner shell record its own pid (== the new process-group id) to
 *     the control file *before* exec'ing the user command, so the worker can
 *     find the group even if the wrapper is later SIGKILLed;
 *  3. forwards TERM/INT to the whole group; and
 *  4. on exit, force-kills the group (sweeping any strays the command left) and
 *     removes the control file.
 *
 * `wait` returns the command's own exit status, which the wrapper re-exits with
 * so E2B surfaces the real code.
 */
export const WRAPPER_PROGRAM = `set -u
: "\${${WRAPPER_ENV.command}:?}"
: "\${${WRAPPER_ENV.commandId}:?}"
: "\${${WRAPPER_ENV.controlDir}:?}"
control="\${${WRAPPER_ENV.controlDir}}/\${${WRAPPER_ENV.commandId}}.pgid"
mkdir -p "\${${WRAPPER_ENV.controlDir}}"
# New session => new process group led by the inner shell; it writes its own pid
# (the group id) then becomes the user command via exec, keeping that pid.
setsid sh -c 'echo $$ > "$0"; exec sh -c "$1"' "$control" "\${${WRAPPER_ENV.command}}" &
child=$!
forward() {
	pgid=$(cat "$control" 2>/dev/null || true)
	[ -n "\${pgid:-}" ] && kill -TERM "-$pgid" 2>/dev/null || true
}
trap forward TERM INT
wait "$child"
code=$?
pgid=$(cat "$control" 2>/dev/null || true)
[ -n "\${pgid:-}" ] && kill -KILL "-$pgid" 2>/dev/null || true
rm -f "$control" 2>/dev/null || true
exit "$code"
`;

/** Round a millisecond grace period to a `sleep`-friendly seconds string. */
function graceSeconds(graceMs: number): string {
	const seconds = Math.max(0, graceMs) / 1000;
	return (Math.round(seconds * 1000) / 1000).toString();
}

/**
 * Signal a command's process group: TERM, a grace period, then KILL. Reads the
 * group id from the control file, so it works from a separate `commands.run`
 * call while the wrapper is still the foreground command. A no-op if the
 * control file is gone (the command already finished and swept itself).
 */
export function buildKillGroupCommand(input: {
	commandId: string;
	controlDir: string;
	graceMs: number;
}): string {
	const control = shellQuote(
		controlFilePath(input.commandId, input.controlDir),
	);
	return `pgid=$(cat ${control} 2>/dev/null || true)
if [ -n "\${pgid:-}" ]; then
	kill -TERM "-$pgid" 2>/dev/null || true
	sleep ${graceSeconds(input.graceMs)}
	kill -KILL "-$pgid" 2>/dev/null || true
fi
`;
}

/**
 * Force-kill the command's process group and print how many processes survive
 * in it (zombies excluded — they are already dead and awaiting reap). A
 * non-zero count means cleanup genuinely failed and the sandbox must be
 * tainted. Also removes the control file.
 */
export function buildReapCommand(input: {
	commandId: string;
	controlDir: string;
}): string {
	const control = shellQuote(
		controlFilePath(input.commandId, input.controlDir),
	);
	return `pgid=$(cat ${control} 2>/dev/null || true)
count=0
if [ -n "\${pgid:-}" ]; then
	kill -KILL "-$pgid" 2>/dev/null || true
	count=$(ps -eo pgid=,stat= 2>/dev/null | awk -v g="$pgid" '$1==g && $2 !~ /Z/ {n++} END{print n+0}')
fi
rm -f ${control} 2>/dev/null || true
printf '%s\\n' "$count"
`;
}

/** Parse the trailing survivor count printed by {@link buildReapCommand}. */
export function parseReapSurvivors(stdout: string): number {
	const lines = stdout.trim().split("\n");
	const last = lines[lines.length - 1]?.trim() ?? "";
	const parsed = Number.parseInt(last, 10);
	// Unparseable output means we cannot prove the group is empty; treat as a
	// survivor so an ambiguous cleanup taints rather than silently passing.
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : 1;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
