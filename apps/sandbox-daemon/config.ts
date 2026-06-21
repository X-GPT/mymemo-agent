/**
 * Typed, validated configuration for the sandbox daemon. Built once from the
 * environment at the entrypoint (`daemon-entry.ts`) and injected down (into
 * `createDaemon` → routes → `spawnAgent`/`createConversationWorkspace`) so no
 * other daemon module reads global process state. This mirrors the gateway's
 * `loadConfigFromEnv` → `createGateway(config, db)` pattern and lets tests
 * construct config explicitly instead of mutating `process.env`.
 *
 * Scope: this covers the daemon's OWN settings. The env the daemon forwards
 * INTO the spawned agent child (PATH, CLAUDE_CODE_PATH, AGENT_SESSION_STORE_ROOT,
 * the hydration-limit overrides) is deliberately not modeled here — that is the
 * child's configuration surface, read where it is forwarded in `child-spawn.ts`.
 */

/** Default port for Bun.serve (the daemon's HTTP listener). */
const DEFAULT_DAEMON_PORT = 8080;
/** Surfaced by /health when DAEMON_VERSION is unset. */
const DEFAULT_DAEMON_VERSION = "unknown";
/**
 * Root of the sandbox workspace tree. Must stay in sync with the sandbox
 * template's setWorkdir (apps/chat-api/sandbox-template/template.ts).
 */
const DEFAULT_WORKSPACE_ROOT = "/workspace";
/** Path the chat-api writes the agent bundle to inside the sandbox. */
const DEFAULT_AGENT_BUNDLE_PATH = "/workspace/agent.js";
/** Bun on PATH runs the agent bundle. */
const DEFAULT_BUN_EXECUTABLE = "bun";

// The agent is a streaming workload of unbounded but "chatty" duration, so a
// wall-clock cap alone would kill healthy long turns. We bound it two ways (see
// child-spawn.ts for the full rationale):
//
//   1. An idle timeout, re-armed on every NDJSON event (text or heartbeat). So
//      sustained silence genuinely means a hang, and a healthy long tool no
//      longer trips it.
//   2. A generous absolute per-turn ceiling as a backstop for the one case the
//      idle timeout can't see: a tool that hangs forever keeps heartbeating.
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_AGENT_MAX_TURN_MS = 600_000;

/** Subset of the process environment the daemon reads. */
type Env = Record<string, string | undefined>;

// These parsers fall back to the default on a malformed value rather than
// throwing (unlike the gateway's `parsePort`, which fails fast). The daemon runs
// inside the sandbox where there is no operator to read a boot error, and a
// malformed watchdog value that became the live timeout would SIGKILL every turn
// at spawn — so a safe default beats aborting. Required secrets are absent here
// (the only secret, DAEMON_AUTH_TOKEN, fails closed at request time), so there
// is nothing to fail-fast on.

/** Parse a TCP port: an integer in 1..65535, else the fallback. */
function parsePort(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const n = Number(value);
	return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/**
 * Parse a positive-millisecond duration. Falls back on any non-finite or
 * non-positive value rather than throwing: `Number("")` is 0 and
 * `Number("abc")` is NaN, and `setTimeout(fn, 0|NaN)` fires immediately — so a
 * malformed watchdog value must NOT become the live timeout or it would SIGKILL
 * every turn at spawn. Falling back keeps a typo from disabling the bound.
 */
function parsePositiveMs(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Spawn settings for the per-turn agent child (see `spawnAgent`). */
export interface AgentSpawnConfig {
	/** Path to the agent bundle (SANDBOX_AGENT_PATH). */
	agentBundlePath: string;
	/** Bun executable used to run the agent bundle (SANDBOX_BUN_PATH). */
	bunExecutable: string;
	/** Idle watchdog timeout in ms, re-armed per event (SANDBOX_AGENT_IDLE_TIMEOUT_MS). */
	agentIdleTimeoutMs: number;
	/** Absolute per-turn ceiling in ms, never re-armed (SANDBOX_AGENT_MAX_TURN_MS). */
	agentMaxTurnMs: number;
}

/** Typed configuration for the sandbox daemon. */
export interface DaemonConfig {
	/** HTTP port for Bun.serve (DAEMON_PORT). */
	daemonPort: number;
	/** Surfaced by /health for the chat-api bundle check (DAEMON_VERSION). */
	daemonVersion: string;
	/**
	 * Bearer secret required on /turn. When unset, every /turn is rejected with
	 * 401 (fail-closed) — preserved as-is so behavior matches the pre-config code.
	 */
	daemonAuthToken: string | undefined;
	/** Root of the sandbox workspace tree (SANDBOX_WORKSPACE_ROOT). */
	workspaceRoot: string;
	/** Settings for spawning the per-turn agent child. */
	agentSpawn: AgentSpawnConfig;
}

/**
 * Parse + validate the environment for the daemon. The single place the daemon
 * reads ambient env for its own configuration; every other module receives the
 * result by injection.
 */
export function loadConfigFromEnv(env: Env): DaemonConfig {
	return {
		daemonPort: parsePort(env.DAEMON_PORT, DEFAULT_DAEMON_PORT),
		daemonVersion: env.DAEMON_VERSION ?? DEFAULT_DAEMON_VERSION,
		daemonAuthToken: env.DAEMON_AUTH_TOKEN,
		workspaceRoot: env.SANDBOX_WORKSPACE_ROOT ?? DEFAULT_WORKSPACE_ROOT,
		agentSpawn: {
			agentBundlePath: env.SANDBOX_AGENT_PATH ?? DEFAULT_AGENT_BUNDLE_PATH,
			bunExecutable: env.SANDBOX_BUN_PATH ?? DEFAULT_BUN_EXECUTABLE,
			agentIdleTimeoutMs: parsePositiveMs(
				env.SANDBOX_AGENT_IDLE_TIMEOUT_MS,
				DEFAULT_AGENT_IDLE_TIMEOUT_MS,
			),
			agentMaxTurnMs: parsePositiveMs(
				env.SANDBOX_AGENT_MAX_TURN_MS,
				DEFAULT_AGENT_MAX_TURN_MS,
			),
		},
	};
}
