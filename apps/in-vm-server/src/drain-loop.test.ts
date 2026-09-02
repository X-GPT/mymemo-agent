import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { conversationMessages, conversations } from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { claimNextTurnTx, enqueueTurnTx } from "@mymemo/agent-db/turn-store";
import { createInMemoryTurnLiveStreamRelay } from "@mymemo/live-text";
import { and, eq } from "drizzle-orm";
import { createAgentSession, type SessionQueryFn } from "./agent-session";
import { type DrainLoopHandle, startDrainLoop } from "./drain-loop";
import { resultError, resultSuccess, textStep } from "./testing/sdk-fixtures";
import type { TurnQueryFn, TurnServingDeps } from "./turn-serving";

const USER_ID = "vm-user";
const CONVERSATION_ID = "vm-conversation";

// Long enough that only an explicit nudge (or stop) can drive the test.
const NEVER_MS = 60_000;

let tdb: TestDb;
let loop: DrainLoopHandle | null = null;

beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values({
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		scope: "general",
	});
});

afterEach(async () => {
	await loop?.stop();
	loop = null;
});

const silentLogger = { warn() {}, error() {} };
const SENTINEL_OPTIONS = { model: "sentinel" } as Options;

async function enqueue(text: string, messageId: string) {
	await enqueueTurnTx(tdb.db, {
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		messageId,
		parts: [{ type: "text", text }],
	});
}

/** A per-Turn query fake that records the prompts it served. `script` may
 * enqueue further Turns mid-stream to exercise mid-Turn arrivals. */
function scriptedTurnQuery(
	served: string[],
	script: (prompt: string) => Promise<SDKMessage[]> | SDKMessage[],
): TurnQueryFn {
	return ({ prompt }) =>
		(async function* () {
			served.push(prompt);
			yield* await script(prompt);
		})();
}

function makeDeps(query: TurnQueryFn): TurnServingDeps {
	return {
		db: tdb.db,
		relay: createInMemoryTurnLiveStreamRelay(),
		userId: USER_ID,
		conversationId: CONVERSATION_ID,
		query,
		queryOptions: SENTINEL_OPTIONS,
		currentTurn: { turnId: null },
		logger: silentLogger,
	};
}

async function turnStatuses(): Promise<Record<string, string | null>> {
	const rows = await tdb.db
		.select({
			messageId: conversationMessages.messageId,
			status: conversationMessages.status,
		})
		.from(conversationMessages)
		.where(
			and(
				eq(conversationMessages.userId, USER_ID),
				eq(conversationMessages.conversationId, CONVERSATION_ID),
				eq(conversationMessages.role, "user"),
			),
		);
	return Object.fromEntries(rows.map((row) => [row.messageId, row.status]));
}

/** Poll until `check` returns truthy (the loop runs in the background). */
async function until(check: () => Promise<boolean>, what: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`timed out waiting for ${what}`);
}

async function allTerminal(expected: Record<string, string>) {
	await until(
		async () => {
			const statuses = await turnStatuses();
			return Object.entries(expected).every(
				([id, status]) => statuses[id] === status,
			);
		},
		`turns to reach ${JSON.stringify(expected)}`,
	);
}

describe("drain loop — a single nudge drains the queue in order", () => {
	it("serves three queued Turns strictly in submission order", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, (prompt) => [
					...textStep(`echo:${prompt}`),
					resultSuccess(),
				]),
			),
			selfHealIntervalMs: NEVER_MS,
		});
		// Let the boot claim find an empty queue and park before enqueueing,
		// so only the single nudge below can drive the drain.
		await Bun.sleep(20);

		await enqueue("one", "turn-1");
		await enqueue("two", "turn-2");
		await enqueue("three", "turn-3");
		loop.nudge();

		await allTerminal({ "turn-1": "done", "turn-2": "done", "turn-3": "done" });
		expect(served).toEqual(["one", "two", "three"]);
	});
});

describe("drain loop — an error Outcome never wedges the loop", () => {
	it("serves the next queued Turn after a Turn ends error", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, (prompt) =>
					prompt === "doomed"
						? [...textStep("partial"), resultError(["provider went away"])]
						: [...textStep(`echo:${prompt}`), resultSuccess()],
				),
			),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("doomed", "turn-1");
		await enqueue("healthy", "turn-2");
		loop.nudge();

		await allTerminal({ "turn-1": "error", "turn-2": "done" });
		expect(served).toEqual(["doomed", "healthy"]);
	});
});

describe("drain loop — no lost work", () => {
	it("picks up a Turn enqueued mid-Turn without another nudge", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, async (prompt) => {
					if (prompt === "first") {
						// Arrives while the first Turn is processing; the nudge for
						// it (rung mid-Turn) is consulted right after the terminal.
						await enqueue("second", "turn-2");
						loop?.nudge();
					}
					return [...textStep(`echo:${prompt}`), resultSuccess()];
				}),
			),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("first", "turn-1");
		loop.nudge();

		await allTerminal({ "turn-1": "done", "turn-2": "done" });
		expect(served).toEqual(["first", "second"]);
	});

	it("the interval tick self-heals a lost nudge", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, (prompt) => [
					...textStep(`echo:${prompt}`),
					resultSuccess(),
				]),
			),
			selfHealIntervalMs: 25,
		});
		await Bun.sleep(20);

		// Enqueued while the loop is parked, and the nudge is lost entirely.
		await enqueue("orphaned", "turn-1");

		await allTerminal({ "turn-1": "done" });
		expect(served).toEqual(["orphaned"]);
	});
});

describe("drain loop — model-side memory across Turns", () => {
	it("a later Turn sees an earlier Turn's context through the one long-lived session", async () => {
		// The honest composition: the drain loop serving through
		// createAgentSession over a context-carrying fake session stream.
		let sessionCalls = 0;
		const sessionQuery: SessionQueryFn = ({ prompt }) => {
			sessionCalls += 1;
			return (async function* () {
				const context: string[] = [];
				for await (const message of prompt) {
					const text =
						typeof message.message.content === "string"
							? message.message.content
							: "";
					context.push(text);
					yield* textStep(`context:${context.join("|")}`);
					yield resultSuccess();
				}
			})();
		};
		loop = startDrainLoop({
			...makeDeps(
				createAgentSession({ query: sessionQuery, options: SENTINEL_OPTIONS }),
			),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("remember me", "turn-1");
		await enqueue("what did I say?", "turn-2");
		loop.nudge();

		await allTerminal({ "turn-1": "done", "turn-2": "done" });
		expect(sessionCalls).toBe(1);

		// The second Turn's assistant text carries the first Turn's prompt.
		const assistants = await tdb.db
			.select({ parts: conversationMessages.parts })
			.from(conversationMessages)
			.where(
				and(
					eq(conversationMessages.userId, USER_ID),
					eq(conversationMessages.conversationId, CONVERSATION_ID),
					eq(conversationMessages.role, "assistant"),
				),
			)
			.orderBy(conversationMessages.sequence);
		expect(assistants).toHaveLength(2);
		expect(JSON.stringify(assistants[1]?.parts)).toContain(
			"context:remember me|what did I say?",
		);
	});
});

describe("drain loop — restart resumes draining", () => {
	it("boot-sweeps the stale processing Turn and drains queued rows with no nudge", async () => {
		// The previous process died mid-Turn: one row stuck processing, more
		// queued behind it.
		await enqueue("stale", "turn-1");
		await claimNextTurnTx(tdb.db, {
			userId: USER_ID,
			conversationId: CONVERSATION_ID,
		});
		await enqueue("queued-a", "turn-2");
		await enqueue("queued-b", "turn-3");

		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, (prompt) => [
					...textStep(`echo:${prompt}`),
					resultSuccess(),
				]),
			),
			selfHealIntervalMs: NEVER_MS,
		});

		await allTerminal({
			"turn-1": "interrupted",
			"turn-2": "done",
			"turn-3": "done",
		});
		// The stale Turn is never re-run — at most once.
		expect(served).toEqual(["queued-a", "queued-b"]);
	});
});

describe("drain loop — the interrupt command (#668)", () => {
	/** A per-Turn query whose stream parks until interrupted, then reports
	 * the SDK's result; uninterrupted prompts complete immediately. */
	function parkingQuery(served: string[], parkOn: string): TurnQueryFn {
		return ({ prompt }) => {
			served.push(prompt);
			let release!: () => void;
			const released = new Promise<void>((resolve) => {
				release = resolve;
			});
			const stream = (async function* () {
				yield* textStep(`echo:${prompt}`);
				if (prompt === parkOn) await released;
				yield resultSuccess();
			})();
			return Object.assign(stream, { interrupt: async () => release() });
		};
	}

	async function untilProcessing(messageId: string) {
		await until(
			async () => (await turnStatuses())[messageId] === "processing",
			`${messageId} to be processing`,
		);
	}

	it("interrupts the in-flight Turn; the next queued Turn then serves normally", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(parkingQuery(served, "long")),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("long", "turn-1");
		await enqueue("next", "turn-2");
		loop.nudge();
		await untilProcessing("turn-1");

		await loop.interrupt("turn-1");

		await allTerminal({ "turn-1": "interrupted", "turn-2": "done" });
		expect(served).toEqual(["long", "next"]);
	});

	it("a target still queued when the command arrives terminalizes interrupted without ever running", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(parkingQuery(served, "long")),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("long", "turn-1");
		await enqueue("doomed", "turn-2");
		await enqueue("after", "turn-3");
		loop.nudge();
		await untilProcessing("turn-1");

		await loop.interrupt("turn-2");
		expect((await turnStatuses())["turn-2"]).toBe("interrupted");
		await loop.interrupt("turn-1");

		await allTerminal({
			"turn-1": "interrupted",
			"turn-2": "interrupted",
			"turn-3": "done",
		});
		expect(served).toEqual(["long", "after"]);
	});

	it("a command for an unknown or finished Turn is dropped; the running Turn is untouched", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(parkingQuery(served, "long")),
			selfHealIntervalMs: NEVER_MS,
		});
		await Bun.sleep(20);

		await enqueue("long", "turn-1");
		loop.nudge();
		await untilProcessing("turn-1");

		await loop.interrupt("no-such-turn");
		expect((await turnStatuses())["turn-1"]).toBe("processing");

		// The retry names the right Turn and lands.
		await loop.interrupt("turn-1");
		await allTerminal({ "turn-1": "interrupted" });
	});
});

describe("drain loop — the suspend hook's graceful-drain gate (#670)", () => {
	/** A Turn whose stream parks until `release` is called. */
	function gatedTurn(served: string[]) {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const query = scriptedTurnQuery(served, async (prompt) => {
			await gate;
			return [...textStep(`echo:${prompt}`), resultSuccess()];
		});
		return { query, release: () => release() };
	}

	it("pause holds new claims while a Turn is in flight and settles at its terminal; resume drains the rest", async () => {
		const served: string[] = [];
		const gated = gatedTurn(served);
		loop = startDrainLoop({
			...makeDeps(gated.query),
			selfHealIntervalMs: NEVER_MS,
		});
		await enqueue("one", "t1");
		await enqueue("two", "t2");
		loop.nudge();
		await until(async () => served.length === 1, "t1 to be claimed");

		let settled = false;
		const paused = loop.pause().then(() => {
			settled = true;
		});
		await Bun.sleep(50);
		expect(settled).toBe(false);

		gated.release();
		await paused;
		expect(await turnStatuses()).toEqual({ t1: "done", t2: "queued" });
		// A nudge while paused claims nothing.
		loop.nudge();
		await Bun.sleep(50);
		expect(served).toEqual(["one"]);

		loop.resume();
		await allTerminal({ t1: "done", t2: "done" });
	});

	it("pause on an idle loop settles at once, and a Turn queued meanwhile waits for resume", async () => {
		const served: string[] = [];
		loop = startDrainLoop({
			...makeDeps(
				scriptedTurnQuery(served, (prompt) => [
					...textStep(`echo:${prompt}`),
					resultSuccess(),
				]),
			),
			selfHealIntervalMs: NEVER_MS,
		});
		await loop.pause();
		await enqueue("one", "t1");
		loop.nudge();
		await Bun.sleep(50);
		expect(await turnStatuses()).toEqual({ t1: "queued" });
		loop.resume();
		await allTerminal({ t1: "done" });
	});

	it("resume releases a pause still waiting on a long Turn", async () => {
		const served: string[] = [];
		const gated = gatedTurn(served);
		loop = startDrainLoop({
			...makeDeps(gated.query),
			selfHealIntervalMs: NEVER_MS,
		});
		await enqueue("one", "t1");
		loop.nudge();
		await until(async () => served.length === 1, "t1 to be claimed");
		const paused = loop.pause();
		loop.resume();
		await paused;
		gated.release();
		await allTerminal({ t1: "done" });
	});
});
