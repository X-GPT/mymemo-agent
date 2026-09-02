import { existsSync } from "node:fs";
import type {
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { InterruptibleStream, TurnQueryFn } from "./turn-serving";

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
 * lazily starts a fresh `query()`.
 *
 * Durability (#670) comes from pinning the session id to the Conversation
 * id (a UUID, which the SDK requires — `config.ts` asserts it): a (re)start
 * creates the session under that id, or resumes it when its transcript is on
 * disk — after a Checkpoint restore on a fresh VM, or
 * after a retired session within one process — so model-side memory
 * follows the Conversation rather than the process.
 */

/** The streaming-input SDK `query()` as a seam: production passes the real
 * function, tests a fake that scripts responses per pushed prompt. */
export type SessionQueryFn = (params: {
	prompt: AsyncIterable<SDKUserMessage>;
	options: Options;
}) => InterruptibleStream;

interface LiveSession {
	push(message: SDKUserMessage): void;
	iterator: AsyncIterator<SDKMessage>;
	/** The SDK's `interrupt()` control on the live query (#668). */
	interrupt(): Promise<unknown>;
}

export function createAgentSession(deps: {
	query: SessionQueryFn;
	/** The confinement bundle, fixed when a session starts. The per-call
	 * options `serveOneTurn` passes are the same object and are ignored. */
	options: Options;
	/** The pinned session id and whether its transcript exists right now.
	 * Unset: an SDK-generated id, process-lifetime only. */
	session?: { id: string; hasTranscript: () => boolean };
}): TurnQueryFn {
	let live: LiveSession | null = null;

	function start(): LiveSession {
		const options = deps.session
			? {
					...deps.options,
					...(deps.session.hasTranscript()
						? { resume: deps.session.id }
						: { sessionId: deps.session.id }),
				}
			: deps.options;
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
		const stream = deps.query({ prompt: prompts(), options });
		return {
			push(message) {
				queue.push(message);
				wake?.();
				wake = null;
			},
			iterator: stream[Symbol.asyncIterator](),
			interrupt: async () => await stream.interrupt?.(),
		};
	}

	return ({ prompt }) => {
		if (live === null) live = start();
		const session = live;
		const window = (async function* () {
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
		// The interrupt control rides the window it targets: the SDK aborts
		// whatever the session is generating right now, which is this window.
		return Object.assign(window, { interrupt: () => session.interrupt() });
	};
}

/**
 * Whether the CLI holds a transcript for `sessionId` under `<claudeDir>/
 * projects/<cwd key>/` — the file `resume` loads. Globbed across project
 * keys so this never has to reproduce the CLI's cwd-to-key derivation.
 */
export function hasTranscript(claudeDir: string, sessionId: string): boolean {
	if (!existsSync(claudeDir)) return false;
	const matches = new Bun.Glob(`projects/*/${sessionId}.jsonl`).scanSync({
		cwd: claudeDir,
	});
	return !matches.next().done;
}
