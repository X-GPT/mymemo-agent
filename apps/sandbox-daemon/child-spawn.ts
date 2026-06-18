/**
 * Spawn helper for the per-turn agent.js child. The daemon never imports the
 * Claude Agent SDK itself — it lives exclusively in agent.js. The agent's LLM
 * credentials are not provider keys: it gets a gateway base URL + short-lived
 * bearer token, supplied per turn.
 *
 * The agent speaks NDJSON on stdout. We line-buffer, parse, and dispatch.
 *
 * Isolation: the agent runs directly (`bun /workspace/agent.js`) — the sandbox
 * itself (the per-turn E2B sandbox in prod, the daemon's container locally) is
 * the security boundary. The agent holds no provider key, runs under the SDK's
 * scoped tool surface (see agent-tools.ts), and is treated as untrusted, so dev
 * and prod share this one spawn path.
 *
 * Bundle paths are env-overridable for tests; in production sandboxes the
 * chat-api writes the two bundles to /workspace/{daemon,agent}.js, and the local
 * container bakes them at the same paths.
 */

import type { AgentEvent } from "./ipc-protocol";

export type { AgentEvent } from "./ipc-protocol";

function getAgentBundlePath(): string {
	return process.env.SANDBOX_AGENT_PATH ?? "/workspace/agent.js";
}
function getBunExecutable(): string {
	return process.env.SANDBOX_BUN_PATH ?? "bun";
}

// The agent is a streaming workload of unbounded but "chatty" duration, so a
// wall-clock cap alone would kill healthy long turns. We bound it two ways:
//
//   1. An idle timeout, re-armed on every NDJSON event. Text streaming covers
//      the model phase; a `heartbeat` (emitted by agent.ts while a tool runs —
//      tool execution is otherwise silent on stdout) covers tool phases. So
//      sustained silence now genuinely means a hang (a wedged model read), and
//      a healthy long tool no longer trips this.
//   2. A generous absolute per-turn ceiling as a backstop for the one case the
//      idle timeout can't see: a tool that hangs forever keeps the heartbeat
//      ticking, so without this it would never be killed and would pin the
//      single-turn lock. Set far above any legitimate turn.
const DEFAULT_AGENT_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_AGENT_MAX_TURN_MS = 600_000;

// Number("") -> 0 and Number("abc") -> NaN, and setTimeout(fn, 0|NaN) fires
// immediately — a malformed env var would SIGKILL every turn at spawn. Fall
// back to the default on any non-finite or non-positive value.
function getPositiveMsEnv(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}
function getAgentIdleTimeoutMs(): number {
	return getPositiveMsEnv(
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS,
		DEFAULT_AGENT_IDLE_TIMEOUT_MS,
	);
}
function getAgentMaxTurnMs(): number {
	return getPositiveMsEnv(
		process.env.SANDBOX_AGENT_MAX_TURN_MS,
		DEFAULT_AGENT_MAX_TURN_MS,
	);
}

// Durable root the agent's SessionStore mirror writes to (must match
// SESSION_STORE_ROOT_ENV in session-store.ts, which the agent reads). Unset =
// session mirroring disabled. The agent's FileSystemSessionStore creates its own
// per-conversation subtree on first write, so the daemon only forwards the root.
const SESSION_STORE_ROOT_ENV = "AGENT_SESSION_STORE_ROOT";
function getSessionStoreRoot(): string | undefined {
	const root = process.env[SESSION_STORE_ROOT_ENV];
	return root && root.length > 0 ? root : undefined;
}

/**
 * Build the argv for the agent process. The agent runs directly under bun — the
 * sandbox/container is the isolation boundary, so there is no wrapper. Extracted
 * as a pure helper so the command is easy to inspect and unit-test.
 */
export function buildAgentSpawnArgv(): string[] {
	return [getBunExecutable(), getAgentBundlePath()];
}

function narrowAgentEvent(raw: Record<string, unknown>): AgentEvent | null {
	switch (raw.type) {
		case "text_delta":
			if (typeof raw.text === "string")
				return { type: "text_delta", text: raw.text };
			return null;
		case "session_id":
			if (typeof raw.sessionId === "string")
				return { type: "session_id", sessionId: raw.sessionId };
			return null;
		case "heartbeat":
			return { type: "heartbeat" };
		case "completed":
			return { type: "completed" };
		case "failed":
			if (typeof raw.message === "string")
				return { type: "failed", message: raw.message };
			return null;
		default:
			return null;
	}
}

async function* readNdjson(
	stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Record<string, unknown>, void, void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl).trim();
				buf = buf.slice(nl + 1);
				if (line) {
					try {
						const parsed = JSON.parse(line);
						if (typeof parsed === "object" && parsed !== null) {
							yield parsed as Record<string, unknown>;
						}
					} catch {
						// Non-JSON line — ignore (e.g. stray stderr leaking via stdout)
					}
				}
				nl = buf.indexOf("\n");
			}
		}
		if (buf.trim()) {
			try {
				const parsed = JSON.parse(buf.trim());
				if (typeof parsed === "object" && parsed !== null) {
					yield parsed as Record<string, unknown>;
				}
			} catch {}
		}
	} finally {
		reader.releaseLock();
	}
}

async function drainStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			if (text.trim()) process.stderr.write(text);
		}
	} finally {
		reader.releaseLock();
	}
}

export interface SpawnAgentInput {
	userQuery: string;
	systemPrompt: string;
	cwd: string;
	/**
	 * Per-conversation CLAUDE_CONFIG_DIR (a sibling of cwd, from the workspace
	 * layout). Set on the agent so the SDK's config + transcript writes stay
	 * isolated from the agent's project `.claude`. Created by the caller
	 * (createConversationWorkspace) before spawn, like cwd.
	 */
	claudeConfigDir: string;
	sessionId?: string;
	/** Trusted member code — keys the durable session-transcript store. */
	userId?: string;
	/** Trusted conversation id — keys the durable session-transcript store. */
	conversationId?: string;
	/** LLM gateway base URL — set as ANTHROPIC_BASE_URL for the Claude binary. */
	llmBaseUrl: string;
	/** Document gateway base URL — set as MYMEMO_DOC_GATEWAY_URL for the CLI. */
	docGatewayUrl: string;
	/**
	 * Short-lived LLM bearer token (aud: "llm") — set as ANTHROPIC_AUTH_TOKEN for
	 * the Claude binary. Holds no document scope.
	 */
	llmToken: string;
	/**
	 * Short-lived document bearer token (aud: "documents") — set as
	 * MYMEMO_DOC_TOKEN for the `mymemo-docs` CLI. Carries the signed scope the
	 * document gateway enforces.
	 */
	docToken: string;
	onEvent: (event: AgentEvent) => void | Promise<void>;
}

export interface SpawnAgentResult {
	exitCode: number;
}

export async function spawnAgent(
	input: SpawnAgentInput,
): Promise<SpawnAgentResult> {
	const {
		onEvent,
		llmBaseUrl,
		docGatewayUrl,
		llmToken,
		docToken,
		claudeConfigDir,
		...config
	} = input;
	// Forward the durable transcript root only when mirroring is configured and
	// the turn carries identity — the agent's SessionStore derives its
	// per-{user,conversation} subtree from the root + the identity threaded
	// through the stdin config below. Absent root/identity => mirroring disabled.
	const sessionStoreRoot =
		config.userId && config.conversationId ? getSessionStoreRoot() : undefined;
	const proc = Bun.spawn(buildAgentSpawnArgv(), {
		env: {
			// The agent holds no provider key — it talks to the LLM gateway, which
			// injects the real key. ANTHROPIC_AUTH_TOKEN is sent as a Bearer header.
			ANTHROPIC_BASE_URL: llmBaseUrl,
			ANTHROPIC_AUTH_TOKEN: llmToken,
			// Document access: the `mymemo-docs` CLI (on PATH) calls the document
			// gateway with its own (aud: "documents") token. The gateway enforces
			// the token's signed scope, so the agent holds no document credential.
			MYMEMO_DOC_GATEWAY_URL: docGatewayUrl,
			MYMEMO_DOC_TOKEN: docToken,
			PATH: process.env.PATH ?? "",
			CLAUDE_CODE_PATH: process.env.CLAUDE_CODE_PATH ?? "/usr/local/bin/claude",
			// Per-conversation config + transcript home (a sibling of cwd, not the
			// project `.claude`). Sandbox-local, so the SDK's local writes are
			// isolated per conversation and the shared ~/.claude stays read-only.
			CLAUDE_CONFIG_DIR: claudeConfigDir,
			// Where the agent's SessionStore mirrors transcripts. Forwarded only
			// when mirroring is configured and identity is present; absent => the
			// agent builds no store and mirroring is disabled.
			...(sessionStoreRoot
				? { [SESSION_STORE_ROOT_ENV]: sessionStoreRoot }
				: {}),
		},
		stdout: "pipe",
		stderr: "pipe",
		stdin: "pipe",
	});

	proc.stdin.write(JSON.stringify(config));
	await proc.stdin.end();

	// Idle watchdog + absolute ceiling. The SIGKILL lands on the agent process,
	// which closes stdout and unblocks the read loop below.
	const idleMs = getAgentIdleTimeoutMs();
	const maxTurnMs = getAgentMaxTurnMs();
	let timedOut = false;
	let hitMaxTurn = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdleTimer = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(() => {
			timedOut = true;
			// Cancel the backstop so it can't fire later and mislabel the cause.
			clearTimeout(maxTurnTimer);
			proc.kill("SIGKILL");
		}, idleMs);
	};
	armIdleTimer();

	// Absolute backstop — never re-armed. Bounds a turn that stays "alive" on
	// heartbeats forever (e.g. a tool that hangs and never returns).
	const maxTurnTimer = setTimeout(() => {
		timedOut = true;
		hitMaxTurn = true;
		clearTimeout(idleTimer);
		proc.kill("SIGKILL");
	}, maxTurnMs);

	// The timer stays armed through the post-loop stderr drain and exit wait,
	// so a child that closes stdout but never exits is still killed. If the
	// agent already delivered a terminal event by then, that kill is cleanup,
	// not a turn failure — suppress the synthetic failed.
	let sawTerminalEvent = false;

	try {
		const stderrPromise = drainStderr(proc.stderr);
		for await (const event of readNdjson(proc.stdout)) {
			armIdleTimer();
			const narrowed = narrowAgentEvent(event);
			if (narrowed) {
				if (narrowed.type === "completed" || narrowed.type === "failed") {
					sawTerminalEvent = true;
				}
				await onEvent(narrowed);
			}
		}
		await stderrPromise;
		const exitCode = await proc.exited;

		if (timedOut && !sawTerminalEvent) {
			await onEvent({
				type: "failed",
				message: hitMaxTurn
					? `agent turn exceeded max duration: ${maxTurnMs}ms`
					: `agent idle timeout: no events for ${idleMs}ms`,
			});
		}
		return { exitCode };
	} finally {
		clearTimeout(idleTimer);
		clearTimeout(maxTurnTimer);
	}
}
