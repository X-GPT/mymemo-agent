import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, inArray, sql } from "drizzle-orm";
import {
	InvalidRunEventError,
	RunEventType,
	validateDurableRunEventSequence,
} from "./run-events";
import {
	ActiveRunConflictError,
	type AdmitQueuedRunInput,
	admitQueuedRunTx,
	appendRunEventsTx,
	appendRunEventTx,
	expireUnownedQueuedRunsTx,
	loadRunStartedTx,
	markLiveStreamFailedTx,
	RunInputMismatchError,
	type RunRecord,
	type RunWriteOwner,
	reclaimConversationTx,
	requestRunInterruptionTx,
	type TerminalTransitionResult,
	transitionRunTerminalTx,
} from "./run-store";
import { conversationRuntime, conversations, runEvents, runs } from "./schema";
import {
	acquireQueuedRunForTest,
	createTestDatabase,
	lapseConversationOwnership,
	seedQueuedRun,
	type TestDb,
} from "./testing";

let tdb: TestDb;

/** Unwrap a terminal transition the test expects to have committed. */
function committed(result: TerminalTransitionResult): RunRecord {
	if (result.outcome !== "committed") {
		throw new Error(
			`expected a committed terminal transition, got ${JSON.stringify(result)}`,
		);
	}
	return result.run;
}

// One PGlite (WASM) instance for the whole file — a per-test instance
// multiplies WASM memory that is not reclaimed promptly and OOMs CI runners.
// Tests are isolated by clearing the tables they touch instead.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(conversations);
	await tdb.db.insert(conversations).values([
		{
			userId: "user-1",
			conversationId: "conv-1",
			scope: "general",
			executionRuntime: "agentcore",
		},
		{
			userId: "user-1",
			conversationId: "conv-2",
			scope: "general",
			executionRuntime: "agentcore",
		},
	]);
});

describe("admitQueuedRunTx", () => {
	const admission = {
		runId: "client-run-1",
		userId: "user-1",
		conversationId: "conv-1",
		messageId: "client-message-1",
		text: "Summarize my notes",
		scope: "collection",
		collectionId: "collection-1",
		summaryId: null,
	} as const;

	it("persists the client Run identity and normalized submitted message atomically", async () => {
		const result = await admitQueuedRunTx(tdb.db, admission);

		expect(result.outcome).toBe("created");
		if (result.outcome !== "created") throw new Error("unreachable");
		expect(result.run).toMatchObject({
			runId: "client-run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			normalizedInput: {
				version: 1,
				messageId: "client-message-1",
				text: "Summarize my notes",
			},
			nextEventSeq: 2,
			executedByWorkerId: null,
			interruptRequestedAt: null,
			terminalAt: null,
		});
		expect(await readEvents("client-run-1")).toMatchObject([
			{
				seq: 1,
				type: RunEventType.Started,
				payload: {
					runId: "client-run-1",
					conversationId: "conv-1",
					messageId: "client-message-1",
					message: "Summarize my notes",
					scope: "collection",
					collectionId: "collection-1",
					summaryId: null,
				},
			},
		]);
	});

	it("reattaches an exact normalized retry without writing another event", async () => {
		await admitQueuedRunTx(tdb.db, admission);

		const retry = await admitQueuedRunTx(tdb.db, admission);

		expect(retry).toMatchObject({
			outcome: "existing",
			run: { runId: "client-run-1", status: "queued" },
		});
		expect(await readEvents("client-run-1")).toHaveLength(1);
	});

	it("reattaches the active Run's own retry instead of raising backpressure against it", async () => {
		// An already-admitted Run id skips the Active Run count and falls through
		// to the `run_id` arbiter. Count it instead and every in-flight client
		// retry would be reported as a conflicting second Run.
		await admitQueuedRunTx(tdb.db, admission);
		await tdb.db
			.update(runs)
			.set({ status: "running", executedByWorkerId: "worker-1" })
			.where(eq(runs.runId, admission.runId));

		const retry = await admitQueuedRunTx(tdb.db, admission);

		expect(retry).toMatchObject({
			outcome: "existing",
			run: { runId: "client-run-1", status: "running" },
		});
		expect(await readEvents("client-run-1")).toHaveLength(1);
	});

	it("rejects an owned Run id reused with different normalized input", async () => {
		await admitQueuedRunTx(tdb.db, admission);

		await expect(
			admitQueuedRunTx(tdb.db, { ...admission, text: "Different work" }),
		).rejects.toBeInstanceOf(RunInputMismatchError);
		await expect(
			admitQueuedRunTx(tdb.db, {
				...admission,
				messageId: "different-message-id",
			}),
		).rejects.toBeInstanceOf(RunInputMismatchError);
		expect(await readEvents("client-run-1")).toHaveLength(1);
	});

	it("makes foreign ownership and Conversation binding indistinguishable from absence", async () => {
		await admitQueuedRunTx(tdb.db, admission);

		expect(
			await admitQueuedRunTx(tdb.db, { ...admission, userId: "other-user" }),
		).toEqual({ outcome: "not_found" });
		expect(
			await admitQueuedRunTx(tdb.db, {
				...admission,
				conversationId: "other-conversation",
			}),
		).toEqual({ outcome: "not_found" });
	});

	it("preserves active-Run backpressure for a different client Run id", async () => {
		await admitQueuedRunTx(tdb.db, admission);

		await expect(
			admitQueuedRunTx(tdb.db, { ...admission, runId: "client-run-2" }),
		).rejects.toBeInstanceOf(ActiveRunConflictError);
	});

	it("reattaches a finished Run's retry even while a later Run is active", async () => {
		// Identity outranks the bound: this retry is about a Run that already
		// reached its Outcome, so it must resolve to that Run — and let the caller
		// answer with Conversation history — rather than be told the Conversation
		// is busy with the unrelated Run that followed it.
		await admitQueuedRunTx(tdb.db, admission);
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, "client-run-1"));
		await admitQueuedRunTx(tdb.db, {
			...admission,
			runId: "client-run-2",
			messageId: "client-message-2",
		});

		const retry = await admitQueuedRunTx(tdb.db, admission);

		expect(retry).toMatchObject({
			outcome: "existing",
			run: { runId: "client-run-1", status: "done" },
		});
	});

	it("resolves a foreign Run id as absence even while the Conversation is busy", async () => {
		await admitQueuedRunTx(tdb.db, {
			...admission,
			conversationId: "conv-2",
			runId: "client-run-elsewhere",
		});
		await admitQueuedRunTx(tdb.db, admission);

		expect(
			await admitQueuedRunTx(tdb.db, {
				...admission,
				runId: "client-run-elsewhere",
			}),
		).toEqual({ outcome: "not_found" });
	});

	it("counts an interrupted-but-unfinished Run against the bound", async () => {
		// `interrupt_requested` is Active: the Run has not reached its Outcome, and
		// the next one waits for it.
		await admitQueuedRunTx(tdb.db, admission);
		await tdb.db
			.update(runs)
			.set({ status: "running", executedByWorkerId: "worker-1" })
			.where(eq(runs.runId, admission.runId));
		expect(
			await requestRunInterruptionTx(tdb.db, {
				userId: "user-1",
				conversationId: "conv-1",
				runId: "client-run-1",
			}),
		).toMatchObject({ outcome: "interrupt_requested" });

		await expect(
			admitQueuedRunTx(tdb.db, { ...admission, runId: "client-run-2" }),
		).rejects.toBeInstanceOf(ActiveRunConflictError);
	});

	it("admits a fresh client Run id once the previous Run is terminal", async () => {
		await admitQueuedRunTx(tdb.db, admission);
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, "client-run-1"));

		const next = await admitQueuedRunTx(tdb.db, {
			...admission,
			runId: "client-run-2",
			messageId: "client-message-2",
		});

		expect(next).toMatchObject({
			outcome: "created",
			run: { runId: "client-run-2", status: "queued" },
		});
	});

	it("rejects malformed canonical admission before writing the Run", async () => {
		await expect(
			admitQueuedRunTx(tdb.db, {
				...admission,
				scope: "everything" as AdmitQueuedRunInput["scope"],
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect(
			await tdb.db.select().from(runs).where(eq(runs.runId, "client-run-1")),
		).toEqual([]);
	});
});

async function queueRun(runId: string, conversationId: string) {
	await tdb.db
		.insert(conversations)
		.values({
			userId: "user-1",
			conversationId,
			scope: "general",
			executionRuntime: "agentcore",
		})
		.onConflictDoNothing();
	return await seedQueuedRun(tdb.db, {
		runId,
		userId: "user-1",
		conversationId,
	});
}

/** Push a run's created_at into the past so acquired-order tests are deterministic
 * (PGlite can give two inserts the same timestamp). */
async function backdateRun(runId: string, msAgo: number) {
	await tdb.db
		.update(runs)
		.set({ createdAt: sql`now() - (${msAgo} * interval '1 millisecond')` })
		.where(eq(runs.runId, runId));
}

async function ageRunsPastQueueTimeout(...runIds: string[]) {
	await tdb.db
		.update(runs)
		.set({
			createdAt: sql`now() - interval '11 minutes'`,
			updatedAt: sql`now() - interval '11 minutes'`,
		})
		.where(inArray(runs.runId, runIds));
}

async function readRun(runId: string) {
	const [row] = await tdb.db.select().from(runs).where(eq(runs.runId, runId));
	return row;
}

function lapseOwnershipLease(conversationId: string) {
	return lapseConversationOwnership(tdb.db, {
		userId: "user-1",
		conversationId,
	});
}

/** Queue and acquire one run so append/terminal tests start from live Ownership. */
async function acquireRun(
	runId: string,
	conversationId: string,
	workerId: string,
): Promise<RunWriteOwner> {
	await queueRun(runId, conversationId);
	await backdateRun(runId, 5_000);
	const acquired = await acquireQueuedRunForTest(tdb.db, { runId, workerId });
	if (!acquired) throw new Error("test setup acquired no Conversation");
	return acquired;
}

function owner(overrides: Partial<RunWriteOwner> = {}): RunWriteOwner {
	return {
		runId: "run-1",
		conversationId: "conv-1",
		workerId: "worker-1",
		userId: "user-1",
		epoch: 1,
		...overrides,
	};
}

async function readEvents(runId: string) {
	return await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
}

describe("appendRunEventTx", () => {
	it("rejects a lapsed Ownership epoch without allocating a sequence number", async () => {
		await queueRun("run-1", "conv-1");
		const acquired = await acquireQueuedRunForTest(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});
		if (!acquired) throw new Error("test setup acquired no Conversation");
		await lapseOwnershipLease("conv-1");

		expect(
			await appendRunEventTx(tdb.db, {
				owner: {
					userId: acquired.userId,
					conversationId: acquired.conversationId,
					epoch: acquired.epoch,
					runId: "run-1",
					workerId: "worker-1",
				},
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "message-1", text: "too late" },
				appendClass: "model",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect((await readRun("run-1"))?.nextEventSeq).toBe(1);
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("allocates monotonic database-owned sequence numbers", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const first = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "message-1", text: "hel" },
			appendClass: "model",
		});
		const second = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "message-2", text: "lo" },
			appendClass: "model",
		});

		expect(first).toEqual({ outcome: "appended", seq: 1 });
		expect(second).toEqual({ outcome: "appended", seq: 2 });
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.AssistantMessageCompleted],
			[2, RunEventType.AssistantMessageCompleted],
		]);
		expect(events[0]?.payload).toEqual({
			messageId: "message-1",
			text: "hel",
		});
	});

	it("rejects malformed known events without consuming a sequence number", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.AssistantMessageCompleted,
				payload: { text: "missing a stable message id" },
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);

		expect(await readEvents("run-1")).toEqual([]);
		const [run] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-1"));
		expect(run?.nextEventSeq).toBe(1);
	});

	it("rejects terminal events outside the terminal status transition", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.Done,
				payload: { outcome: "done" },
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("reserves run_started for atomic admission", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.Started,
				payload: {
					runId: "run-1",
					conversationId: "conv-1",
					messageId: "user-message-2",
					message: "second submission",
					scope: "general",
					collectionId: null,
					summaryId: null,
				},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("persists stable Assistant and correlated Tool identities in order", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		const events = [
			{
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			},
			{
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-1", delta: '{"path":"notes.md"}' },
			},
			{
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-1" },
			},
			{
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-1", text: "I will check." },
			},
			{
				type: RunEventType.ToolCallResult,
				payload: {
					messageId: "tool-message-1",
					toolCallId: "tool-1",
					content: "Read completed",
					isError: false,
				},
			},
		] as const;

		for (const event of events) {
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				...event,
				appendClass: "model",
			});
		}

		expect(
			(await readEvents("run-1")).map(({ seq, type, payload }) => ({
				seq,
				type,
				payload,
			})),
		).toEqual(events.map((event, index) => ({ seq: index + 1, ...event })));
	});

	it("appends a UI payload only after its owning Assistant completes", async () => {
		await admitQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			messageId: "user-message-1",
			text: "Show the results",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
		const acquired = await acquireQueuedRunForTest(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});
		if (!acquired) throw new Error("test setup acquired no Conversation");
		const runOwner = acquired;
		const appendUiPayload = (messageId: string) =>
			appendRunEventTx(tdb.db, {
				owner: runOwner,
				type: RunEventType.UiPayload,
				payload: {
					messageId,
					version: 1,
					payload: { component: "chart", props: { spec: {} } },
				},
				appendClass: "model",
			});

		await expect(appendUiPayload("assistant-message-1")).rejects.toBeInstanceOf(
			InvalidRunEventError,
		);
		await expect(appendUiPayload("user-message-1")).rejects.toBeInstanceOf(
			InvalidRunEventError,
		);
		await appendRunEventTx(tdb.db, {
			owner: runOwner,
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "assistant-message-1", text: "Here it is." },
			appendClass: "model",
		});
		expect(await appendUiPayload("assistant-message-1")).toEqual({
			outcome: "appended",
			seq: 3,
		});

		await appendRunEventsTx(tdb.db, {
			owner: runOwner,
			appendClass: "model",
			events: [
				{
					type: RunEventType.ToolCallStarted,
					payload: {
						toolCallId: "tool-1",
						toolCallName: "Read",
						parentMessageId: "assistant-message-1",
					},
				},
				{
					type: RunEventType.ToolCallArgs,
					payload: { toolCallId: "tool-1", delta: "{}" },
				},
				{
					type: RunEventType.ToolCallCompleted,
					payload: { toolCallId: "tool-1" },
				},
				{
					type: RunEventType.ToolCallResult,
					payload: {
						messageId: "tool-message-1",
						toolCallId: "tool-1",
						content: "Read completed",
						isError: false,
					},
				},
			],
		});
		await expect(appendUiPayload("tool-message-1")).rejects.toBeInstanceOf(
			InvalidRunEventError,
		);
	});

	it("fences UI payload appends by Ownership epoch and running status", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		const input = {
			type: RunEventType.UiPayload,
			payload: {
				messageId: "assistant-message-1",
				version: 1,
				payload: { component: "table", props: { columns: [], rows: [] } },
			},
			appendClass: "model",
		} as const;

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner({ epoch: 999, workerId: "worker-2" }),
				...input,
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));
		expect(
			await appendRunEventTx(tdb.db, { owner: owner(), ...input }),
		).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});
	});

	it("rejects a UI payload through the cancellation append class", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "assistant-message-1", text: "Results" },
			appendClass: "model",
		});
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await expect(
			appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.UiPayload,
				payload: {
					messageId: "assistant-message-1",
					version: 1,
					payload: { component: "chart", props: { spec: {} } },
				},
				appendClass: "cancellation",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			RunEventType.AssistantMessageCompleted,
		]);
	});

	it("atomically appends one complete Tool invocation lifecycle", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		const events = [
			{
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			},
			{
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-1", delta: '{"path":"notes.md"}' },
			},
			{
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-1" },
			},
		] as const;

		expect(
			await appendRunEventsTx(tdb.db, {
				owner: owner(),
				events,
				appendClass: "model",
			}),
		).toEqual({
			outcome: "appended",
			events: [{ seq: 1 }, { seq: 2 }, { seq: 3 }],
		});
		expect(
			(await readEvents("run-1")).map(({ seq, type, payload }) => ({
				seq,
				type,
				payload,
			})),
		).toEqual(events.map((event, index) => ({ seq: index + 1, ...event })));
	});

	it("rejects orphaned, duplicate, and out-of-order Tool lifecycle events", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		const append = (type: string, payload: Record<string, unknown>) =>
			appendRunEventTx(tdb.db, {
				owner: owner(),
				type,
				payload,
				appendClass: "model",
			});

		await expect(
			append(RunEventType.ToolCallArgs, {
				toolCallId: "tool-1",
				delta: "{}",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		await append(RunEventType.AssistantMessageCompleted, {
			messageId: "assistant-1",
			text: "",
		});
		await append(RunEventType.ToolCallStarted, {
			toolCallId: "tool-1",
			toolCallName: "Read",
			parentMessageId: "assistant-1",
		});
		await expect(
			append(RunEventType.ToolCallResult, {
				messageId: "tool-message-1",
				toolCallId: "tool-1",
				content: "too early",
				isError: false,
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		await append(RunEventType.ToolCallArgs, {
			toolCallId: "tool-1",
			delta: '{"path":"notes.md"}',
		});
		await expect(
			append(RunEventType.ToolCallArgs, {
				toolCallId: "tool-1",
				delta: "{}",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		await append(RunEventType.ToolCallCompleted, { toolCallId: "tool-1" });
		await expect(
			append(RunEventType.ToolCallResult, {
				messageId: "tool-message-1",
				toolCallId: "unknown-tool",
				content: "unknown",
				isError: false,
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		await append(RunEventType.ToolCallResult, {
			messageId: "tool-message-1",
			toolCallId: "tool-1",
			content: "Read completed",
			isError: false,
		});
		await expect(
			append(RunEventType.ToolCallResult, {
				messageId: "tool-message-2",
				toolCallId: "tool-1",
				content: "duplicate",
				isError: false,
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
	});

	it("does not treat worker provenance as append authority", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner({ workerId: "worker-2" }),
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "message-1", text: "epoch owns this" },
				appendClass: "model",
			}),
		).toMatchObject({ outcome: "appended", seq: 1 });
	});

	it("rejects model appends after interruption is requested", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "message-1", text: "too late" },
				appendClass: "model",
			}),
		).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});
	});

	it("sequences canonical Tool lifecycle events with Assistant text", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const toolStart = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallStarted,
			payload: {
				toolCallId: "tool-1",
				toolCallName: "Bash",
				parentMessageId: "message-1",
			},
			appendClass: "model",
		});
		const toolArgs = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallArgs,
			payload: { toolCallId: "tool-1", delta: '{"command":"ls"}' },
			appendClass: "model",
		});
		const toolEnd = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallCompleted,
			payload: { toolCallId: "tool-1" },
			appendClass: "model",
		});
		const toolResult = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallResult,
			payload: {
				messageId: "tool-message-1",
				toolCallId: "tool-1",
				content: '{"exitCode":0}',
				isError: false,
			},
			appendClass: "model",
		});
		const text = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "message-1", text: "done" },
			appendClass: "model",
		});

		expect([toolStart, toolArgs, toolEnd, toolResult, text]).toEqual([
			{ outcome: "appended", seq: 1 },
			{ outcome: "appended", seq: 2 },
			{ outcome: "appended", seq: 3 },
			{ outcome: "appended", seq: 4 },
			{ outcome: "appended", seq: 5 },
		]);
		expect((await readEvents("run-1")).map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.ToolCallStarted],
			[2, RunEventType.ToolCallArgs],
			[3, RunEventType.ToolCallCompleted],
			[4, RunEventType.ToolCallResult],
			[5, RunEventType.AssistantMessageCompleted],
		]);
	});

	// Tool events ride the same `model` append class as assistant text, so the
	// same fence rejects them once the run leaves `running`…
	it("rejects a tool-event model append after interruption is requested", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "message-1",
				},
				appendClass: "model",
			}),
		).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});
	});

	// …or the worker no longer owns it.
	it("rejects a tool-event append from a worker that lost ownership", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await lapseOwnershipLease("conv-1");

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.ToolCallResult,
				payload: {
					messageId: "tool-message-1",
					toolCallId: "tool-1",
					content: "preview",
					isError: false,
				},
				appendClass: "model",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
	});

	it("allows cancellation audit appends while running or interrupt_requested", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const whileRunning = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: "model_interrupt_requested",
			payload: {},
			appendClass: "cancellation",
		});
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));
		const whileInterruptRequested = await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: "command_canceled",
			payload: {},
			appendClass: "cancellation",
		});

		expect(whileRunning).toEqual({ outcome: "appended", seq: 1 });
		expect(whileInterruptRequested).toEqual({ outcome: "appended", seq: 2 });
	});

	it("fences cancellation audit appends by the Ownership deadline", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));
		await lapseOwnershipLease("conv-1");

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				type: "command_canceled",
				payload: {},
				appendClass: "cancellation",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
	});
});

describe("transitionRunTerminalTx", () => {
	it.each([
		"done",
		"interrupted",
	] as const)("validates and retains UI payloads when a Run becomes %s", async (status) => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "assistant-message-1", text: "Results" },
			appendClass: "model",
		});
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.UiPayload,
			payload: {
				messageId: "assistant-message-1",
				version: 1,
				payload: { component: "diagram", props: { source: "flowchart LR" } },
			},
			appendClass: "model",
		});
		if (status === "interrupted") {
			await requestRunInterruptionTx(tdb.db, {
				runId: "run-1",
				userId: "user-1",
				conversationId: "conv-1",
			});
		}

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status,
			}),
		).toMatchObject({ outcome: "committed", run: { status } });
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			RunEventType.AssistantMessageCompleted,
			RunEventType.UiPayload,
			status === "done" ? RunEventType.Done : RunEventType.Interrupted,
		]);
	});

	it("rejects a lapsed Ownership epoch without committing an Outcome", async () => {
		await queueRun("run-1", "conv-1");
		const acquired = await acquireQueuedRunForTest(tdb.db, {
			workerId: "worker-1",
		});
		if (!acquired) throw new Error("test setup acquired no Conversation");
		await lapseOwnershipLease("conv-1");

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: acquired,
				status: "done",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect((await readRun("run-1"))?.status).toBe("running");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it.each([
		"done",
		"interrupted",
	] as const)("publishes the first Agent-session pointer atomically with %s", async (status) => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		if (status === "interrupted") {
			await tdb.db
				.update(runs)
				.set({ status: "interrupt_requested" })
				.where(eq(runs.runId, "run-1"));
		}

		await transitionRunTerminalTx(tdb.db, {
			owner: owner(),
			status,
			agentSessionId: "session-first",
		});

		const [runtime] = await tdb.db.select().from(conversationRuntime);
		const [run] = await tdb.db.select().from(runs);
		expect(runtime?.agentSessionId).toBe("session-first");
		expect(run?.status).toBe(status);
	});

	it("writes no pointer when the terminal Outcome loses a status race", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
		});
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));

		const result = await transitionRunTerminalTx(tdb.db, {
			owner: owner(),
			status: "done",
			agentSessionId: "session-rolled-back",
		});

		expect(result).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});
		const [runtime] = await tdb.db.select().from(conversationRuntime);
		const [run] = await tdb.db.select().from(runs);
		expect(runtime?.agentSessionId).toBeNull();
		expect(run?.status).toBe("interrupt_requested");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("terminalizes without a pointer when the optional runtime row is absent", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const terminal = committed(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "done",
				agentSessionId: "session-without-runtime",
			}),
		);

		const [run] = await tdb.db.select().from(runs);
		expect(terminal.status).toBe("done");
		expect(run?.status).toBe("done");
		expect(await tdb.db.select().from(conversationRuntime)).toEqual([]);
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			"run_done",
		]);
	});

	it("rejects terminalization with an incomplete Tool lifecycle", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallStarted,
			payload: {
				toolCallId: "tool-1",
				toolCallName: "Read",
				parentMessageId: "assistant-1",
			},
			appendClass: "model",
		});

		await expect(
			transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "error",
				payload: { message: "Run failed" },
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		const [run] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-1"));
		expect(run?.status).toBe("running");
		expect((await readEvents("run-1")).map((event) => event.type)).toEqual([
			RunEventType.ToolCallStarted,
		]);
	});

	it("allows an errored Run to retain a completed Tool without a result", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		for (const event of [
			{
				type: RunEventType.ToolCallStarted,
				payload: {
					toolCallId: "tool-1",
					toolCallName: "Read",
					parentMessageId: "assistant-1",
				},
			},
			{
				type: RunEventType.ToolCallArgs,
				payload: { toolCallId: "tool-1", delta: "{}" },
			},
			{
				type: RunEventType.ToolCallCompleted,
				payload: { toolCallId: "tool-1" },
			},
		] as const) {
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				...event,
				appendClass: "model",
			});
		}

		const run = committed(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "error",
				payload: { message: "Run failed" },
			}),
		);

		expect(run.status).toBe("error");
	});

	it("completes a running run and appends exactly one run_done event", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.AssistantMessageCompleted,
			payload: { messageId: "message-1", text: "hi" },
			appendClass: "model",
		});

		const run = committed(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "done",
			}),
		);

		expect(run).toMatchObject({
			runId: "run-1",
			status: "done",
			executedByWorkerId: "worker-1",
		});
		expect(run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.AssistantMessageCompleted],
			[2, "run_done"],
		]);
		expect(events[1]?.payload).toEqual({ outcome: "done" });
	});

	it("rejects a second terminal transition for the same run", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			owner: owner(),
			status: "done",
		});

		// The epoch still holds, so the classifier names the immutable status.
		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "error",
				payload: { message: "boom" },
			}),
		).toEqual({ outcome: "rejected", rejected: "status", current: "done" });
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("refuses done once interruption was requested; interrupted wins", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));

		// The rejection names the status the Run actually holds, which is what
		// lets the worker pick `interrupted` instead of retrying blindly.
		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "done",
			}),
		).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});

		const run = committed(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "interrupted",
			}),
		);
		expect(run.status).toBe("interrupted");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_interrupted"]);
	});

	it("refuses error once interruption was requested", async () => {
		// "Do not overload `error` for user-directed interruption": after
		// interrupt_requested the only legal terminal is interrupted, even when the
		// SDK errors during the interrupt.
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-1"));

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "error",
				payload: { message: "sdk exploded mid-interrupt" },
			}),
		).toEqual({
			outcome: "rejected",
			rejected: "status",
			current: "interrupt_requested",
		});
	});

	it("marks a running run as error with the error payload", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const run = committed(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "error",
				payload: { message: "sandbox died" },
			}),
		);

		expect(run.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.type, e.payload])).toEqual([
			["run_error", { message: "sandbox died", outcome: "error" }],
		]);
	});

	it("rejects a terminal transition from a superseded or lapsed acquisition", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			agentSessionId: "session-old",
		});

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner({ epoch: 999, workerId: "worker-2" }),
				status: "done",
				agentSessionId: "session-new",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("session-old");

		await lapseOwnershipLease("conv-1");
		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "done",
				agentSessionId: "session-new",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect(
			(await tdb.db.select().from(conversationRuntime))[0]?.agentSessionId,
		).toBe("session-old");
	});

	it("names a deleted Conversation as gone rather than a lost lease", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		// Permanent Conversation deletion; its Runs cascade with it. The worker
		// has nothing left to terminalize and no successor to stand aside for,
		// which is why this is not the `lease` rejection.
		await tdb.db
			.delete(conversations)
			.where(eq(conversations.conversationId, "conv-1"));

		expect(
			await transitionRunTerminalTx(tdb.db, {
				owner: owner(),
				status: "done",
			}),
		).toEqual({ outcome: "rejected", rejected: "gone" });
	});
});

describe("requestRunInterruptionTx", () => {
	const ref = { runId: "run-1", userId: "user-1", conversationId: "conv-1" };

	it("interrupts a queued run immediately and appends run_interrupted", async () => {
		await queueRun("run-1", "conv-1");

		const result = await requestRunInterruptionTx(tdb.db, ref);

		expect(result.outcome).toBe("interrupted");
		if (result.outcome !== "interrupted") throw new Error("unreachable");
		expect(result.run).toMatchObject({
			runId: "run-1",
			status: "interrupted",
			executedByWorkerId: null,
		});
		expect(result.run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, "run_interrupted"],
		]);
		expect(events[0]?.payload).toEqual({ outcome: "interrupted" });
	});

	it("moves a running run to interrupt_requested and leaves ownership intact", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		const result = await requestRunInterruptionTx(tdb.db, ref);

		expect(result.outcome).toBe("interrupt_requested");
		if (result.outcome !== "interrupt_requested")
			throw new Error("unreachable");
		expect(result.run.status).toBe("interrupt_requested");
		expect(result.run.executedByWorkerId).toBe("worker-1");
		expect(result.run.interruptRequestedAt).toBeInstanceOf(Date);
		// No terminal event yet: the owning worker appends run_interrupted when it
		// actually terminalizes.
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("is idempotent while interruption is already requested", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await requestRunInterruptionTx(tdb.db, ref);

		const again = await requestRunInterruptionTx(tdb.db, ref);

		expect(again.outcome).toBe("interrupt_requested");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("stays a success when retried after the interruption already won", async () => {
		await queueRun("run-1", "conv-1");
		await requestRunInterruptionTx(tdb.db, ref);

		const retry = await requestRunInterruptionTx(tdb.db, ref);

		// ADR-0013 retry contract: an interruption that already won reports
		// `interrupted`, distinct from the `done`/`error` conflict — and stays
		// idempotent (no second terminal event).
		expect(retry.outcome).toBe("interrupted");
		if (retry.outcome !== "interrupted") throw new Error("unreachable");
		expect(retry.run.status).toBe("interrupted");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_interrupted"]);
	});

	it("stays a success when retried after the owner terminalized interrupted", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await requestRunInterruptionTx(tdb.db, ref);
		await transitionRunTerminalTx(tdb.db, {
			owner: owner(),
			status: "interrupted",
		});

		const retry = await requestRunInterruptionTx(tdb.db, ref);

		expect(retry.outcome).toBe("interrupted");
		if (retry.outcome !== "interrupted") throw new Error("unreachable");
		expect(retry.run.status).toBe("interrupted");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_interrupted"]);
	});

	it("reports an already-terminal run without touching it", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			owner: owner(),
			status: "done",
		});

		const result = await requestRunInterruptionTx(tdb.db, ref);

		expect(result.outcome).toBe("already_terminal");
		if (result.outcome !== "already_terminal") throw new Error("unreachable");
		expect(result.run.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("reports not_found for missing or foreign runs", async () => {
		await queueRun("run-1", "conv-1");

		expect(
			await requestRunInterruptionTx(tdb.db, {
				...ref,
				runId: "run-ghost",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunInterruptionTx(tdb.db, {
				...ref,
				userId: "user-2",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunInterruptionTx(tdb.db, {
				...ref,
				conversationId: "conv-2",
			}),
		).toEqual({ outcome: "not_found" });
	});
});

describe("markLiveStreamFailedTx", () => {
	it("rejects an active marker after the Ownership lease lapses", async () => {
		await queueRun("run-1", "conv-1");
		const acquired = await acquireQueuedRunForTest(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});
		if (!acquired) throw new Error("test setup acquired no Conversation");
		await lapseOwnershipLease("conv-1");

		expect(
			await markLiveStreamFailedTx(tdb.db, {
				owner: acquired,
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
		expect((await readRun("run-1"))?.liveStreamFailedAt).toBeNull();
	});

	it("marks an active Run only through its live Ownership fence", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");

		expect(
			await markLiveStreamFailedTx(tdb.db, {
				owner: owner({ epoch: 999, workerId: "other-worker" }),
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });

		const marked = await markLiveStreamFailedTx(tdb.db, {
			owner: owner(),
		});
		expect(marked.outcome).toBe("marked");
		if (marked.outcome !== "marked") throw new Error("unreachable");
		expect(marked.run.status).toBe("running");
		expect(marked.run.liveStreamFailedAt).toBeInstanceOf(Date);
	});

	it("is idempotent for the owning worker without moving the timestamp", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		const first = await markLiveStreamFailedTx(tdb.db, {
			owner: owner(),
		});
		if (first.outcome !== "marked") throw new Error("unreachable");

		const again = await markLiveStreamFailedTx(tdb.db, {
			owner: owner(),
		});

		expect(again.outcome).toBe("already_failed");
		if (again.outcome !== "already_failed") throw new Error("unreachable");
		expect(again.run.liveStreamFailedAt).toEqual(first.run.liveStreamFailedAt);
	});

	it("rejects expired ownership but permits the monotonic null-to-time write after terminalization", async () => {
		await acquireRun("run-expired", "conv-expired", "worker-1");
		await lapseOwnershipLease("conv-expired");
		expect(
			await markLiveStreamFailedTx(tdb.db, {
				owner: owner({
					runId: "run-expired",
					conversationId: "conv-expired",
				}),
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });

		await acquireRun("run-terminal", "conv-terminal", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			owner: owner({
				runId: "run-terminal",
				conversationId: "conv-terminal",
			}),
			status: "done",
		});
		const marked = await markLiveStreamFailedTx(tdb.db, {
			owner: owner({
				runId: "run-terminal",
				conversationId: "conv-terminal",
			}),
		});

		expect(marked.outcome).toBe("marked");
		if (marked.outcome !== "marked") throw new Error("unreachable");
		expect(marked.run).toMatchObject({ status: "done" });
		expect(marked.run.liveStreamFailedAt).toBeInstanceOf(Date);
		expect(
			(await readEvents("run-terminal")).map(({ payload }) => payload),
		).toEqual([{ outcome: "done" }]);
		const again = await markLiveStreamFailedTx(tdb.db, {
			owner: owner({
				runId: "run-terminal",
				conversationId: "conv-terminal",
				epoch: 999,
				workerId: "any-worker-after-terminal",
			}),
		});
		expect(again.outcome).toBe("already_failed");
		if (again.outcome !== "already_failed") throw new Error("unreachable");
		expect(again.run.updatedAt).toEqual(marked.run.updatedAt);
	});
});

describe("Run liveness sweep transactions", () => {
	it("uses the AgentCore queued backstop without consulting the compatibility marker", async () => {
		await queueRun("run-agentcore-queued", "conv-1");
		await tdb.db
			.update(runs)
			.set({
				createdAt: sql`now() - interval '2 minutes'`,
				updatedAt: sql`now() - interval '2 minutes'`,
			})
			.where(eq(runs.runId, "run-agentcore-queued"));

		expect(await expireUnownedQueuedRunsTx(tdb.db)).toBeNull();
		expect((await readRun("run-agentcore-queued"))?.status).toBe("queued");

		await tdb.db
			.update(runs)
			.set({
				createdAt: sql`now() - interval '11 minutes'`,
				updatedAt: sql`now() - interval '11 minutes'`,
			})
			.where(eq(runs.runId, "run-agentcore-queued"));

		expect(
			(await expireUnownedQueuedRunsTx(tdb.db))?.runs.map((run) => run.status),
		).toEqual(["error"]);
	});

	it("reclaims expired AgentCore Ownership through the shared fence", async () => {
		await tdb.db
			.update(conversations)
			.set({
				executionRuntime: "agentcore",
				ownerWorkerId: "dead-agentcore-invocation",
				ownerUntil: sql`now() - interval '1 second'`,
				epoch: 1,
			})
			.where(eq(conversations.conversationId, "conv-1"));
		await tdb.db.insert(runs).values({
			runId: "run-agentcore-running",
			userId: "user-1",
			conversationId: "conv-1",
			status: "running",
			executedByWorkerId: "dead-agentcore-invocation",
		});

		const reclamation = await reclaimConversationTx(tdb.db);

		expect(reclamation).toMatchObject({
			conversationId: "conv-1",
			runs: [{ runId: "run-agentcore-running", status: "error" }],
		});
	});

	it("Reclamation closes a Run after a crash left an incomplete Tool prefix", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			owner: owner(),
			type: RunEventType.ToolCallStarted,
			payload: {
				toolCallId: "tool-1",
				toolCallName: "Read",
				parentMessageId: "assistant-1",
			},
			appendClass: "model",
		});
		await lapseOwnershipLease("conv-1");

		const reclamation = await reclaimConversationTx(tdb.db);

		expect(reclamation?.runs).toMatchObject([
			{
				runId: "run-1",
				status: "error",
				liveStreamFailedAt: expect.any(Date),
			},
		]);
		const events = await readEvents("run-1");
		expect(events.map((event) => event.type)).toEqual([
			RunEventType.ToolCallStarted,
			RunEventType.Error,
		]);
		expect(() => validateDurableRunEventSequence(events)).not.toThrow();
	});

	it("terminalizes a running Run after its Ownership lease lapses", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			agentSessionId: "session-existing",
		});
		await lapseOwnershipLease("conv-1");

		const reclamation = await reclaimConversationTx(tdb.db);
		const reclaimedRuns = reclamation?.runs ?? [];

		expect(reclaimedRuns.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "error"],
		]);
		expect(reclaimedRuns[0]?.executedByWorkerId).toBe("worker-1");
		expect(reclaimedRuns[0]?.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.type, e.payload])).toEqual([
			[
				"run_error",
				{
					message: "Run failed",
					outcome: "error",
					reason: "stale_worker",
				},
			],
		]);
		expect(reclaimedRuns[0]?.liveStreamFailedAt).toBeInstanceOf(Date);
		const [runtime] = await tdb.db
			.select()
			.from(conversationRuntime)
			.where(eq(conversationRuntime.conversationId, "conv-1"));
		expect(runtime?.agentSessionId).toBe("session-existing");
	});

	it("terminalizes started Runs and gives queued Runs a fresh timeout window for the next acquisition", async () => {
		await acquireRun("run-running", "conv-1", "worker-1");
		await queueRun("run-interrupted", "conv-1");
		await queueRun("run-queued", "conv-1");
		await tdb.db
			.update(runs)
			.set({ status: "interrupt_requested" })
			.where(eq(runs.runId, "run-interrupted"));
		await ageRunsPastQueueTimeout("run-interrupted", "run-queued");
		await lapseOwnershipLease("conv-1");

		const reclaimed = await reclaimConversationTx(tdb.db);

		expect(
			reclaimed?.runs
				.map((run) => [run.runId, run.status])
				.sort(([left], [right]) => String(left).localeCompare(String(right))),
		).toEqual([
			["run-interrupted", "interrupted"],
			["run-running", "error"],
		]);
		expect(await readEvents("run-interrupted")).toMatchObject([
			{ type: "run_interrupted", payload: { reason: "stale_worker" } },
		]);
		expect((await readRun("run-queued"))?.status).toBe("queued");
		expect(await readEvents("run-queued")).toEqual([]);
		expect(await expireUnownedQueuedRunsTx(tdb.db)).toBeNull();
		expect(
			await acquireQueuedRunForTest(tdb.db, { workerId: "worker-2" }),
		).toMatchObject({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect((await readRun("run-queued"))?.status).toBe("running");
	});

	it("taints the conversation's sandbox so the next turn cannot reconnect to it", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sandbox-1",
		});
		await lapseOwnershipLease("conv-1");

		await reclaimConversationTx(tdb.db);

		const [runtime] = await tdb.db
			.select()
			.from(conversationRuntime)
			.where(eq(conversationRuntime.conversationId, "conv-1"));
		expect(runtime).toMatchObject({
			sandboxId: "sandbox-1",
			sandboxTainted: true,
		});
		const [conversation] = await tdb.db
			.select()
			.from(conversations)
			.where(eq(conversations.conversationId, "conv-1"));
		expect(conversation).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
		});
	});

	it("preserves the Workspace when the lapsed Conversation has no started Active Run", async () => {
		await acquireRun("run-done", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "done", terminalAt: sql`now()` })
			.where(eq(runs.runId, "run-done"));
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sandbox-1",
		});
		await lapseOwnershipLease("conv-1");

		const reclamation = await reclaimConversationTx(tdb.db);

		expect(reclamation?.runs).toEqual([]);
		const [runtime] = await tdb.db
			.select()
			.from(conversationRuntime)
			.where(eq(conversationRuntime.conversationId, "conv-1"));
		expect(runtime).toMatchObject({
			sandboxId: "sandbox-1",
			sandboxTainted: false,
		});
		const [conversation] = await tdb.db
			.select()
			.from(conversations)
			.where(eq(conversations.conversationId, "conv-1"));
		expect(conversation).toMatchObject({
			ownerWorkerId: null,
			ownerUntil: null,
		});
	});

	it("taints after an accepted interruption too — command cleanup is equally unproven", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sandbox-1",
		});
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await lapseOwnershipLease("conv-1");

		await reclaimConversationTx(tdb.db);

		const [runtime] = await tdb.db
			.select()
			.from(conversationRuntime)
			.where(eq(conversationRuntime.conversationId, "conv-1"));
		expect(runtime?.sandboxTainted).toBe(true);
	});

	it("leaves the sandbox untainted when an unowned queued run ages out", async () => {
		await queueRun("run-queued", "conv-1");
		await tdb.db.insert(conversationRuntime).values({
			userId: "user-1",
			conversationId: "conv-1",
			sandboxId: "sandbox-1",
		});
		await ageRunsPastQueueTimeout("run-queued");

		await expireUnownedQueuedRunsTx(tdb.db);

		const [runtime] = await tdb.db
			.select()
			.from(conversationRuntime)
			.where(eq(conversationRuntime.conversationId, "conv-1"));
		expect(runtime?.sandboxTainted).toBe(false);
	});

	it("terminalizes interrupt_requested after its Ownership lease lapses", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await requestRunInterruptionTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await lapseOwnershipLease("conv-1");

		const reclaimedRuns = (await reclaimConversationTx(tdb.db))?.runs ?? [];

		expect(reclaimedRuns.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "interrupted"],
		]);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_interrupted"]);
	});

	it("leaves queued Runs and live Ownership alone", async () => {
		await queueRun("run-queued", "conv-1");
		await acquireRun("run-live", "conv-2", "worker-1");

		const reclamation = await reclaimConversationTx(tdb.db);

		expect(reclamation).toBeNull();
		const [queued] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-queued"));
		const [live] = await tdb.db
			.select()
			.from(runs)
			.where(eq(runs.runId, "run-live"));
		expect(queued?.status).toBe("queued");
		expect(live?.status).toBe("running");
	});

	it("does not age out a queued Run waiting behind work in a live Conversation", async () => {
		await acquireRun("run-running", "conv-1", "worker-1");
		await queueRun("run-waiting", "conv-1");
		await ageRunsPastQueueTimeout("run-waiting");

		expect(await expireUnownedQueuedRunsTx(tdb.db)).toBeNull();
		expect((await readRun("run-running"))?.status).toBe("running");
		expect((await readRun("run-waiting"))?.status).toBe("queued");
	});

	it("terminalizes old unowned queued runs as error", async () => {
		await queueRun("run-queued", "conv-1");
		await ageRunsPastQueueTimeout("run-queued");

		const expiredRuns = (await expireUnownedQueuedRunsTx(tdb.db))?.runs ?? [];

		expect(expiredRuns.map((r) => [r.runId, r.status])).toEqual([
			["run-queued", "error"],
		]);
		const events = await readEvents("run-queued");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("never double-terminalizes: a second sweep finds nothing", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await lapseOwnershipLease("conv-1");
		await reclaimConversationTx(tdb.db);

		const again = await reclaimConversationTx(tdb.db);

		expect(again).toBeNull();
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("rejects the former owner's appends once Reclamation has terminalized", async () => {
		await acquireRun("run-1", "conv-1", "worker-1");
		await lapseOwnershipLease("conv-1");
		await reclaimConversationTx(tdb.db);

		expect(
			await appendRunEventTx(tdb.db, {
				owner: owner(),
				type: RunEventType.AssistantMessageCompleted,
				payload: {},
				appendClass: "model",
			}),
		).toEqual({ outcome: "rejected", rejected: "lease" });
	});
});

describe("loadRunStartedTx", () => {
	/** Insert a run_started event the way chat-api's admission transaction does:
	 * seq 1, with the counter already advanced past it. */
	async function insertRunStarted(runId: string, payload: object) {
		await tdb.db
			.update(runs)
			.set({ nextEventSeq: 2 })
			.where(eq(runs.runId, runId));
		await tdb.db.insert(runEvents).values({
			runId,
			seq: 1,
			type: "run_started",
			payload,
		});
	}

	it("loads the user message and frozen scope columns", async () => {
		await queueRun("run-1", "conv-1");
		await insertRunStarted("run-1", {
			userId: "user-1",
			conversationId: "conv-1",
			runId: "run-1",
			message: "summarize my notes",
			scope: "collection",
			collectionId: "col-9",
			summaryId: null,
		});

		const started = await loadRunStartedTx(tdb.db, { runId: "run-1" });

		expect(started).toEqual({
			message: "summarize my notes",
			scope: "collection",
			collectionId: "col-9",
			summaryId: null,
		});
	});

	it("normalizes absent scope ids to null", async () => {
		await queueRun("run-1", "conv-1");
		await insertRunStarted("run-1", {
			message: "hello",
			scope: "general",
		});

		const started = await loadRunStartedTx(tdb.db, { runId: "run-1" });

		expect(started).toEqual({
			message: "hello",
			scope: "general",
			collectionId: null,
			summaryId: null,
		});
	});

	it("throws when the run has no run_started event", async () => {
		await queueRun("run-1", "conv-1");

		await expect(loadRunStartedTx(tdb.db, { runId: "run-1" })).rejects.toThrow(
			/run_started/,
		);
	});

	it("throws when the payload carries no string message or scope", async () => {
		await queueRun("run-1", "conv-1");
		await insertRunStarted("run-1", { scope: "general" });

		await expect(loadRunStartedTx(tdb.db, { runId: "run-1" })).rejects.toThrow(
			/run_started/,
		);
	});
});
