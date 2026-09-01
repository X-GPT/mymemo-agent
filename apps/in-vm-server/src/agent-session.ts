import type {
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { TurnQueryFn } from "./turn-serving";

/**
 * ONE long-lived SDK `query()` carrying the Agent session across Turns
 * (spec #654, ticket #664): streaming-input mode keeps the CLI process and
 * its model-side context alive between Turns, so a later Turn sees an
 * earlier Turn's context within one process lifetime.
 *
 * `createAgentSession` adapts that single stream to `serveOneTurn`'s
 * per-Turn `TurnQueryFn`: each call pushes one user message into the shared
 * prompt channel and yields the session's messages up to and including that
 * Turn's `result`. Windows never overlap — the DB's one-in-flight gate
 * serializes the callers.
 *
 * A session that breaks — the underlying stream throws, ends, or a Turn
 * window is abandoned before its `result` (a protocol violation or
 * persistence failure inside the caller) — is retired, and the next Turn
 * lazily starts a fresh `query()`. Model-side memory resets with it: the
 * guarantee is process-lifetime and best-effort, never durable.
 */

/** The streaming-input SDK `query()` as a seam: production passes the real
 * function, tests a fake that scripts responses per pushed prompt. */
export type SessionQueryFn = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => AsyncIterable<SDKMessage>;

interface LiveSession {
	push(message: SDKUserMessage): void;
	iterator: AsyncIterator<SDKMessage>;
}

export function createAgentSession(deps: {
	query: SessionQueryFn;
	/** The confinement bundle, fixed when a session starts. The per-call
	 * options `serveOneTurn` passes are the same object and are ignored. */
	options: Options;
}): TurnQueryFn {
	let live: LiveSession | null = null;

	function start(): LiveSession {
		// The prompt channel: at most one message is ever buffered (the DB
		// gate admits one Turn at a time), but buffering makes push safe even
		// before the SDK first pulls.
		const queue: SDKUserMessage[] = [];
		let wake: (() => void) | null = null;
		async function* prompts(): AsyncGenerator<SDKUserMessage> {
			while (true) {
				const next = queue.shift();
				if (next) yield next;
				else
					await new Promise<void>((resolve) => {
						wake = resolve;
					});
			}
		}
		const stream = deps.query({ prompt: prompts(), options: deps.options });
		return {
			push(message) {
				queue.push(message);
				wake?.();
				wake = null;
			},
			iterator: stream[Symbol.asyncIterator](),
		};
	}

	return ({ prompt }) =>
		(async function* () {
			if (live === null) live = start();
			const session = live;
			session.push({
				type: "user",
				message: { role: "user", content: prompt },
				parent_tool_use_id: null,
			});
			let sawResult = false;
			try {
				while (true) {
					const next = await session.iterator.next();
					// The CLI exited: the window ends result-less, and
					// serveOneTurn terminalizes the Turn as a protocol error.
					if (next.done) return;
					yield next.value;
					if (next.value.type === "result") {
						sawResult = true;
						return;
					}
				}
			} finally {
				if (!sawResult && live === session) {
					// Broken or abandoned mid-Turn: the shared stream is no
					// longer aligned on a Turn boundary. Retire it (closing the
					// CLI with it) so the next Turn starts clean instead of
					// reading this Turn's tail.
					live = null;
					void session.iterator.return?.().catch(() => {});
				}
			}
		})();
}
