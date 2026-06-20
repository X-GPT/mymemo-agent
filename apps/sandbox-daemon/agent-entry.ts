/**
 * Agent command: runs a Claude Agent SDK query and streams events as NDJSON,
 * then exits. Spawned per-turn by the daemon under a scrubbed environment
 * (no daemon secrets).
 *
 * Stdin:   single JSON object —
 *            { userQuery, systemPrompt, cwd, sessionId?, userId?, conversationId? }
 * Stdout:  NDJSON, one event per line —
 *            { type: "text_delta", text: "..." }
 *            { type: "session_id", sessionId: "..." }
 *            { type: "heartbeat" }        (liveness while a tool runs)
 *            { type: "completed" }
 *            { type: "failed", message: "..." }
 * Exit:    0 on completed, 1 on failed.
 *
 * Required env: ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN — the Claude binary
 * calls the LLM gateway (which holds the real provider key) with the bearer
 * token. No provider key is present in this process.
 *
 * No other code path inside the daemon process imports the Claude Agent
 * SDK — this entrypoint owns it in the sandbox bundle graph.
 */

import { runAgent } from "./agent";
import type { AgentEvent } from "./ipc-protocol";
import { createSessionStore, SESSION_STORE_ROOT_ENV } from "./session-store";

interface AgentConfig {
	userQuery: string;
	systemPrompt: string;
	cwd: string;
	sessionId?: string;
	userId?: string;
	conversationId?: string;
	runId?: string;
	docsDir?: string;
}

function emit(event: AgentEvent): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

async function readStdin(): Promise<string> {
	const chunks: Uint8Array[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Uint8Array);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function parseConfig(raw: string): AgentConfig {
	const parsed = JSON.parse(raw) as Partial<AgentConfig>;
	if (
		typeof parsed.userQuery !== "string" ||
		typeof parsed.systemPrompt !== "string" ||
		typeof parsed.cwd !== "string"
	) {
		throw new Error(
			"agent config requires { userQuery, systemPrompt, cwd } strings",
		);
	}
	return {
		userQuery: parsed.userQuery,
		systemPrompt: parsed.systemPrompt,
		cwd: parsed.cwd,
		sessionId:
			typeof parsed.sessionId === "string" ? parsed.sessionId : undefined,
		userId: typeof parsed.userId === "string" ? parsed.userId : undefined,
		conversationId:
			typeof parsed.conversationId === "string"
				? parsed.conversationId
				: undefined,
		runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
		docsDir: typeof parsed.docsDir === "string" ? parsed.docsDir : undefined,
	};
}

async function main() {
	let config: AgentConfig;
	try {
		const raw = await readStdin();
		config = parseConfig(raw);
	} catch (err) {
		emit({
			type: "failed",
			message: err instanceof Error ? err.message : String(err),
		});
		process.exit(1);
	}

	// Mirror SDK session transcripts to durable storage when configured, so
	// `resume` survives a fresh or recycled sandbox. Disabled (null) when no
	// root is set or identity is missing — the SDK then keeps its local
	// transcript only.
	const sessionStore = createSessionStore({
		rootDir: process.env[SESSION_STORE_ROOT_ENV],
		userId: config.userId,
		conversationId: config.conversationId,
	});

	let failed = false;
	await runAgent(
		{ ...config, sessionStore: sessionStore ?? undefined },
		{
			onTextDelta: async (text) => {
				emit({ type: "text_delta", text });
			},
			onSessionId: async (sessionId) => {
				emit({ type: "session_id", sessionId });
			},
			onHeartbeat: () => {
				emit({ type: "heartbeat" });
			},
			onCompleted: async () => {
				emit({ type: "completed" });
			},
			onFailed: async (message) => {
				failed = true;
				emit({ type: "failed", message });
			},
		},
	);

	process.exit(failed ? 1 : 0);
}

main();
