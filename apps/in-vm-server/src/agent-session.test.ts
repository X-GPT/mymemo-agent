import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	Options,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	agentSessionId,
	createAgentSession,
	hasTranscript,
	type SessionQueryFn,
} from "./agent-session";
import { resultSuccess, textStep } from "./testing/sdk-fixtures";

const SENTINEL_OPTIONS = { model: "sentinel" } as Options;

function promptText(message: SDKUserMessage): string {
	return typeof message.message.content === "string"
		? message.message.content
		: "";
}

/** One underlying-query call's observable record. */
interface SessionCall {
	options: Options;
	prompts: string[];
	closed: boolean;
}

/** A scripted long-lived stream: for every pushed prompt, yield the scripted
 * messages. `script` may throw or return null to end the stream result-less. */
function fakeSessionQuery(
	script: (prompt: string, call: number) => SDKMessage[] | null,
): { fn: SessionQueryFn; calls: SessionCall[] } {
	const calls: SessionCall[] = [];
	const fn: SessionQueryFn = ({ prompt, options }) => {
		const call: SessionCall = { options, prompts: [], closed: false };
		const index = calls.push(call) - 1;
		return (async function* () {
			try {
				for await (const message of prompt) {
					call.prompts.push(promptText(message));
					const messages = script(promptText(message), index);
					if (messages === null) return;
					yield* messages;
				}
			} finally {
				call.closed = true;
			}
		})();
	};
	return { fn, calls };
}

describe("createAgentSession — one long-lived query() across Turns", () => {
	it("serves consecutive Turn windows from a single underlying query", async () => {
		const { fn, calls } = fakeSessionQuery((prompt) => [
			...textStep(`echo:${prompt}`),
			resultSuccess(),
		]);
		const turnQuery = createAgentSession({
			query: fn,
			options: SENTINEL_OPTIONS,
		});

		const first = await Array.fromAsync(
			turnQuery({ prompt: "one", options: SENTINEL_OPTIONS }),
		);
		const second = await Array.fromAsync(
			turnQuery({ prompt: "two", options: SENTINEL_OPTIONS }),
		);

		// ONE query() call carried both Turns, in submission order, under the
		// session's options.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.prompts).toEqual(["one", "two"]);
		expect(calls[0]?.options).toBe(SENTINEL_OPTIONS);
		expect(calls[0]?.closed).toBe(false);

		// Each window carries exactly its own Turn's messages, result included.
		expect(first.at(-1)?.type).toBe("result");
		expect(second.at(-1)?.type).toBe("result");
		expect(first).toHaveLength(textStep("x").length + 1);
		expect(second).toHaveLength(textStep("x").length + 1);
	});

	it("a thrown underlying stream fails the window; the next Turn gets a fresh query", async () => {
		const { fn, calls } = fakeSessionQuery((prompt, call) => {
			if (call === 0) throw new Error("the CLI process died");
			return [...textStep(`echo:${prompt}`), resultSuccess()];
		});
		const turnQuery = createAgentSession({
			query: fn,
			options: SENTINEL_OPTIONS,
		});

		await expect(
			Array.fromAsync(
				turnQuery({ prompt: "doomed", options: SENTINEL_OPTIONS }),
			),
		).rejects.toThrow("the CLI process died");

		const next = await Array.fromAsync(
			turnQuery({ prompt: "recovered", options: SENTINEL_OPTIONS }),
		);
		expect(next.at(-1)?.type).toBe("result");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.prompts).toEqual(["recovered"]);
	});

	it("an underlying stream ending without a result retires the session", async () => {
		const { fn, calls } = fakeSessionQuery((prompt, call) =>
			call === 0 ? null : [...textStep(`echo:${prompt}`), resultSuccess()],
		);
		const turnQuery = createAgentSession({
			query: fn,
			options: SENTINEL_OPTIONS,
		});

		// The window ends result-less — serveOneTurn turns that into a
		// protocol error; here we just observe the truncation.
		const truncated = await Array.fromAsync(
			turnQuery({ prompt: "cut off", options: SENTINEL_OPTIONS }),
		);
		expect(truncated.every((message) => message.type !== "result")).toBe(true);

		const next = await Array.fromAsync(
			turnQuery({ prompt: "after restart", options: SENTINEL_OPTIONS }),
		);
		expect(next.at(-1)?.type).toBe("result");
		expect(calls).toHaveLength(2);
	});

	it("abandoning a window mid-Turn closes the underlying stream; the next Turn gets a fresh query", async () => {
		const { fn, calls } = fakeSessionQuery((prompt) => [
			...textStep(`echo:${prompt}`),
			resultSuccess(),
		]);
		const turnQuery = createAgentSession({
			query: fn,
			options: SENTINEL_OPTIONS,
		});

		// The caller aborts before the result (a protocol violation or a
		// persistence failure inside serveOneTurn ends the for-await early).
		const window = turnQuery({
			prompt: "abandoned",
			options: SENTINEL_OPTIONS,
		})[Symbol.asyncIterator]();
		expect((await window.next()).done).toBe(false);
		await window.return?.();
		// The retirement close is fire-and-forget; let its microtasks settle.
		await Bun.sleep(0);

		// The shared stream was mid-Turn, so it is retired — never left for
		// the next window to read this Turn's tail.
		expect(calls[0]?.closed).toBe(true);

		const next = await Array.fromAsync(
			turnQuery({ prompt: "fresh", options: SENTINEL_OPTIONS }),
		);
		expect(next.at(-1)?.type).toBe("result");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.prompts).toEqual(["fresh"]);
	});
});

describe("createAgentSession — the interrupt control (#668)", () => {
	it("forwards a window's interrupt() to the live query, and the session survives it", async () => {
		let interrupts = 0;
		const sessionQuery: SessionQueryFn = ({ prompt }) => {
			const stream = (async function* () {
				for await (const message of prompt) {
					yield* textStep(`echo:${promptText(message)}`);
					yield resultSuccess();
				}
			})();
			return Object.assign(stream, {
				interrupt: async () => {
					interrupts += 1;
				},
			});
		};
		const turnQuery = createAgentSession({
			query: sessionQuery,
			options: SENTINEL_OPTIONS,
		});

		const first = turnQuery({ prompt: "one", options: SENTINEL_OPTIONS });
		await first.interrupt?.();
		expect(interrupts).toBe(1);
		expect((await Array.fromAsync(first)).at(-1)?.type).toBe("result");

		const second = await Array.fromAsync(
			turnQuery({ prompt: "two", options: SENTINEL_OPTIONS }),
		);
		expect(second.at(-1)?.type).toBe("result");
	});
});

describe("the pinned Agent session (#670)", () => {
	it("creates the session under the Conversation's id, and resumes it once its transcript exists", async () => {
		let transcript = false;
		const { fn, calls } = fakeSessionQuery((prompt) =>
			prompt === "break" ? null : [...textStep(prompt), resultSuccess()],
		);
		const turnQuery = createAgentSession({
			query: fn,
			options: SENTINEL_OPTIONS,
			session: { id: "session-1", hasTranscript: () => transcript },
		});

		await Array.fromAsync(
			turnQuery({ prompt: "one", options: SENTINEL_OPTIONS }),
		);
		expect(calls[0]?.options).toEqual({
			...SENTINEL_OPTIONS,
			sessionId: "session-1",
		});

		// The session breaks (result-less window) and is retired; the CLI has
		// written the transcript by now, so the restart resumes it.
		transcript = true;
		await Array.fromAsync(
			turnQuery({ prompt: "break", options: SENTINEL_OPTIONS }),
		);
		await Array.fromAsync(
			turnQuery({ prompt: "two", options: SENTINEL_OPTIONS }),
		);
		expect(calls).toHaveLength(2);
		expect(calls[1]?.options).toEqual({
			...SENTINEL_OPTIONS,
			resume: "session-1",
		});
		expect(calls[1]?.prompts).toEqual(["two"]);
	});

	it("derives one stable UUID per Conversation id, UUID-shaped or not", () => {
		const id = agentSessionId("verify-670-conversation");
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		expect(agentSessionId("verify-670-conversation")).toBe(id);
		expect(agentSessionId("other")).not.toBe(id);
	});

	it("finds the transcript under any project key, and nothing in a missing or empty .claude", () => {
		const claudeDir = path.join(
			mkdtempSync(path.join(tmpdir(), "claude-")),
			".claude",
		);
		expect(hasTranscript(claudeDir, "s1")).toBe(false);
		mkdirSync(path.join(claudeDir, "projects", "-home-developer-workspace"), {
			recursive: true,
		});
		expect(hasTranscript(claudeDir, "s1")).toBe(false);
		writeFileSync(
			path.join(claudeDir, "projects", "-home-developer-workspace", "s1.jsonl"),
			"",
		);
		expect(hasTranscript(claudeDir, "s1")).toBe(true);
		expect(hasTranscript(claudeDir, "s2")).toBe(false);
	});
});
