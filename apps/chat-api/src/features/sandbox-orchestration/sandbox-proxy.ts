import { ConversationBusyError } from "./errors";

export interface TurnRequest {
	request_id: string;
	user_id: string;
	/** Product-visible thread id. Stable across turns of one conversation. */
	conversation_id: string;
	/** Identifies this single backend execution attempt. */
	run_id: string;
	scope_type: "global" | "collection" | "document";
	collection_id?: string;
	summary_id?: string;
	message: string;
	agent_session_id?: string;
	system_prompt: string;
	/** LLM gateway base URL the sandbox agent points the Claude binary at. */
	llm_base_url: string;
	/** Document gateway base URL the sandbox agent's `mymemo-docs` CLI calls. */
	doc_gateway_url: string;
	/**
	 * Short-lived bearer token (aud: "llm") the agent presents to the LLM proxy.
	 * Set as the agent's ANTHROPIC_AUTH_TOKEN.
	 */
	llm_token: string;
	/**
	 * Short-lived bearer token (aud: "documents") the agent's `mymemo-docs` CLI
	 * presents to the document routes. Carries the signed turn scope the gateway
	 * enforces. Set as the agent's MYMEMO_DOC_TOKEN.
	 */
	doc_token: string;
}

interface ForwardOptions {
	daemonUrl: string;
	daemonAuthToken: string;
	turnRequest: TurnRequest;
	onTextDelta: (text: string) => Promise<void>;
	onSessionId: (id: string) => Promise<void>;
}

/**
 * Forward a chat turn to the sandbox daemon via HTTP streaming.
 * Parses NDJSON response once per line and dispatches events.
 */
export async function forwardChatTurnToSandbox(
	options: ForwardOptions,
): Promise<void> {
	const { daemonUrl, daemonAuthToken, turnRequest, onTextDelta, onSessionId } =
		options;

	// Idle-based timeout over the streamed body, re-armed on every chunk —
	// turns are legitimately long, so an absolute timeout over the whole read
	// would abort healthy ones. The window sits at the daemon's Bun idleTimeout
	// (240s, > the daemon's 120s agent watchdog); during a healthy turn the
	// daemon's text + `heartbeat` events keep resetting it, and on a genuine
	// hang the daemon surfaces a `failed` event well before this fires. So this
	// only trips if the daemon goes fully silent (e.g. the process died).
	const IDLE_TIMEOUT_MS = 240_000;
	const idleController = new AbortController();
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	const armIdle = () => {
		clearTimeout(idleTimer);
		idleTimer = setTimeout(
			() =>
				idleController.abort(
					new Error(`daemon idle timeout: no bytes for ${IDLE_TIMEOUT_MS}ms`),
				),
			IDLE_TIMEOUT_MS,
		);
	};

	try {
		armIdle();
		const response = await fetch(`${daemonUrl}/turn`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-daemon-auth-token": daemonAuthToken,
			},
			body: JSON.stringify(turnRequest),
			signal: idleController.signal,
		});

		if (response.status === 409) {
			throw new ConversationBusyError(
				"Sandbox is busy processing another turn",
			);
		}

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			throw new Error(`Daemon returned ${response.status}: ${text}`);
		}

		if (!response.body) {
			throw new Error("Daemon returned no response body");
		}

		let agentError: string | null = null;
		let buffer = "";

		const reader = response.body.getReader();
		const decoder = new TextDecoder();

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			armIdle();

			buffer += decoder.decode(value, { stream: true });

			let newlineIndex = buffer.indexOf("\n");
			while (newlineIndex !== -1) {
				const line = buffer.slice(0, newlineIndex).trim();
				buffer = buffer.slice(newlineIndex + 1);

				if (line) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						// Non-JSON line, ignore
						parsed = null;
					}
					if (typeof parsed === "object" && parsed !== null) {
						const evt = parsed as { type?: string } & Record<string, unknown>;
						switch (evt.type) {
							case "text_delta":
								if (typeof evt.text === "string") {
									await onTextDelta(evt.text);
								}
								break;
							case "session_id":
								if (typeof evt.sessionId === "string") {
									await onSessionId(evt.sessionId);
								}
								break;
							case "heartbeat":
								// Daemon liveness keepalive — re-arms armIdle() above
								// (every chunk does); never surfaced to the client.
								break;
							case "completed":
								break;
							case "failed":
								agentError = (evt.message as string) ?? "Turn failed";
								break;
							case "started":
								break;
						}
					}
				}

				newlineIndex = buffer.indexOf("\n");
			}
		}

		// Flush remaining buffer
		if (buffer.trim()) {
			try {
				const parsed = JSON.parse(buffer.trim());
				if (parsed?.type === "failed")
					agentError = parsed.message ?? "Turn failed";
			} catch {
				// Ignore
			}
		}

		if (agentError) {
			throw new Error(`Sandbox agent error: ${agentError}`);
		}
	} finally {
		clearTimeout(idleTimer);
	}
}
