/**
 * Claude Agent SDK wrapper for running agent queries inside the sandbox.
 * Ported from agent-runner.mjs to TypeScript, adapted for daemon use.
 */

import {
	type HookCallbackMatcher,
	type HookEvent,
	query,
	type SessionStore,
} from "@anthropic-ai/claude-agent-sdk";
import {
	ALLOWED_BUILTIN_TOOLS,
	createCanUseTool,
	createMymemoMcpServer,
	MYMEMO_MCP_SERVER_NAME,
	PRE_APPROVED_TOOLS,
} from "./agent-tools";
import { createHeartbeatController } from "./heartbeat";

export interface AgentRunOptions {
	userQuery: string;
	systemPrompt: string;
	cwd: string;
	sessionId?: string;
	/**
	 * Mirror SDK session transcripts to durable storage so `resume` survives a
	 * fresh or recycled sandbox. Omit to keep today's behavior (local transcript
	 * only). Never paired with `persistSession: false` — the mirror hook fires
	 * after the local write, so local writes must stay enabled.
	 */
	sessionStore?: SessionStore;
}

export interface AgentCallbacks {
	onTextDelta: (text: string) => void | Promise<void>;
	onSessionId: (sessionId: string) => void | Promise<void>;
	/** Internal liveness tick emitted while a tool is executing (no client text). */
	onHeartbeat: () => void | Promise<void>;
	onCompleted: () => void | Promise<void>;
	onFailed: (message: string) => void | Promise<void>;
}

/**
 * Build the Claude Agent SDK `query()` options for a turn. Pure (apart from
 * reading `CLAUDE_CODE_PATH`) so the wiring — `resume`, and the `sessionStore`
 * transcript mirror — is unit-testable without spawning the SDK. `hooks` is
 * layered on separately by `runAgent` since it closes over the heartbeat.
 */
export function buildQueryOptions(
	options: AgentRunOptions,
): Record<string, unknown> {
	const { systemPrompt, cwd, sessionId, sessionStore } = options;

	const queryOptions: Record<string, unknown> = {
		cwd,
		systemPrompt,
		// Lock down the tool surface for the untrusted agent (see agent-tools.ts):
		// `tools` pins the available built-ins (Bash + Read/Grep/Glob), `allowedTools`
		// pre-approves them plus the MyMemo MCP document tool, and `canUseTool`
		// fail-closes anything else under `permissionMode: "default"`. Bash stays for
		// general workspace work; its command surface is bounded by the bwrap/E2B
		// sandbox, not an allowlist (see agent-tools.ts header).
		tools: [...ALLOWED_BUILTIN_TOOLS],
		allowedTools: [...PRE_APPROVED_TOOLS],
		canUseTool: createCanUseTool(),
		mcpServers: { [MYMEMO_MCP_SERVER_NAME]: createMymemoMcpServer() },
		permissionMode: "default",
		includePartialMessages: true,
		model: "claude-sonnet-4-6",
		pathToClaudeCodeExecutable:
			process.env.CLAUDE_CODE_PATH ?? "/usr/local/bin/claude",
	};

	if (sessionId) {
		queryOptions.resume = sessionId;
	}

	// When durable session storage is configured, mirror the SDK transcript to
	// it. Deliberately leave `persistSession` unset (defaults on): the mirror
	// hook runs after the local write, so disabling local writes would silence
	// it.
	if (sessionStore) {
		queryOptions.sessionStore = sessionStore;
	}

	return queryOptions;
}

/**
 * Run a Claude Agent SDK query and stream results through callbacks.
 */
export async function runAgent(
	options: AgentRunOptions,
	callbacks: AgentCallbacks,
): Promise<void> {
	const { userQuery } = options;

	const queryOptions = buildQueryOptions(options);

	// Tool execution emits nothing on stdout, so without this a single tool that
	// runs longer than the idle window trips the daemon watchdog. Pre/PostToolUse
	// hooks bracket every tool's wall-clock; while one is in flight we tick a
	// `heartbeat` to keep the watchdog (and the daemon↔chat-api socket) armed.
	const heartbeat = createHeartbeatController(() => {
		void callbacks.onHeartbeat();
	});
	const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
		PreToolUse: [
			{
				hooks: [
					async (_input, toolUseId) => {
						heartbeat.onToolStart(toolUseId ?? "");
						return {};
					},
				],
			},
		],
		PostToolUse: [
			{
				hooks: [
					async (_input, toolUseId) => {
						heartbeat.onToolEnd(toolUseId ?? "");
						return {};
					},
				],
			},
		],
		// Tool errors take this path instead of PostToolUse; stop the heartbeat
		// here too so a failing tool doesn't leak the interval.
		PostToolUseFailure: [
			{
				hooks: [
					async (_input, toolUseId) => {
						heartbeat.onToolEnd(toolUseId ?? "");
						return {};
					},
				],
			},
		],
	};
	queryOptions.hooks = hooks;

	let result: ReturnType<typeof query>;
	try {
		result = query({
			prompt: userQuery,
			options: queryOptions,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await callbacks.onFailed(`Agent SDK query() failed: ${message}`);
		return;
	}

	let emittedSessionId = false;

	try {
		for await (const msg of result) {
			// Transcript-mirror failures are non-fatal (the batch is dropped,
			// at-most-once) but must not be silent — the turn answers correctly yet
			// resume may be incomplete. Surface to stderr, which the daemon drains
			// into its log; the turn itself continues.
			if (msg.type === "system" && msg.subtype === "mirror_error") {
				console.error(
					`session transcript mirror failed (resume may be incomplete): ${msg.error}`,
				);
				continue;
			}

			if (!emittedSessionId && msg.type === "stream_event") {
				await callbacks.onSessionId(msg.session_id);
				emittedSessionId = true;
			}

			if (msg.type === "stream_event") {
				const event = msg.event;

				if (event.type === "content_block_delta") {
					const delta = event.delta;
					if (delta.type === "text_delta") {
						await callbacks.onTextDelta(delta.text);
					}
				}
			} else if (msg.type === "result") {
				if (!emittedSessionId) {
					await callbacks.onSessionId(msg.session_id);
					emittedSessionId = true;
				}

				if (msg.subtype === "success") {
					await callbacks.onCompleted();
				} else {
					await callbacks.onFailed(`Agent ended with: ${msg.subtype}`);
				}
			}
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await callbacks.onFailed(`Agent stream error: ${message}`);
	} finally {
		// Never leak the interval past the turn, even if a hook's Post* never fired.
		heartbeat.stop();
	}
}
