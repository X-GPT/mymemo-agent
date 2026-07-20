import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { InvalidRunEventError, RunEventType } from "./run-events";
import {
	ActiveRunConflictError,
	admitQueuedRunTx,
	appendRunEventTx,
	claimNextRunTx,
	createQueuedRunTx,
	heartbeatRunTx,
	loadRunStartedTx,
	markLiveStreamFailedTx,
	markStaleRunsTx,
	RunFenceError,
	RunInputMismatchError,
	requestRunCancellationTx,
	transitionRunTerminalTx,
} from "./run-store";
import { runEvents, runs } from "./schema";
import { createTestDatabase, type TestDb } from "./testing";

let tdb: TestDb;

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
});

describe("createQueuedRunTx", () => {
	it("creates a queued run with queue defaults", async () => {
		const run = await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		expect(run).toMatchObject({
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
			status: "queued",
			lockedBy: null,
			lockedUntil: null,
			heartbeatAt: null,
			cancelRequestedAt: null,
			nextEventSeq: 1,
			terminalAt: null,
		});
	});

	it("rejects a second active run for the same conversation", async () => {
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		await expect(
			createQueuedRunTx(tdb.db, {
				runId: "run-2",
				userId: "user-1",
				conversationId: "conv-1",
			}),
		).rejects.toBeInstanceOf(ActiveRunConflictError);
	});

	it("allows a new run once the previous run is terminal", async () => {
		await createQueuedRunTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await tdb.db
			.update(runs)
			.set({ status: "done" })
			.where(eq(runs.runId, "run-1"));

		const next = await createQueuedRunTx(tdb.db, {
			runId: "run-2",
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(next.status).toBe("queued");
	});
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

	it("rejects malformed canonical admission before writing the Run", async () => {
		await expect(
			admitQueuedRunTx(tdb.db, { ...admission, scope: "everything" }),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect(
			await tdb.db.select().from(runs).where(eq(runs.runId, "client-run-1")),
		).toEqual([]);
	});
});

async function queueRun(runId: string, conversationId: string) {
	return await createQueuedRunTx(tdb.db, {
		runId,
		userId: "user-1",
		conversationId,
	});
}

/** Push a run's created_at into the past so claim-order tests are deterministic
 * (PGlite can give two inserts the same timestamp). */
async function backdateRun(runId: string, msAgo: number) {
	await tdb.db
		.update(runs)
		.set({ createdAt: sql`now() - (${msAgo} * interval '1 millisecond')` })
		.where(eq(runs.runId, runId));
}

describe("claimNextRunTx", () => {
	it("returns null when no run is queued", async () => {
		const claimed = await claimNextRunTx(tdb.db, { workerId: "worker-1" });
		expect(claimed).toBeNull();
	});

	it("claims the oldest queued run and takes execution ownership", async () => {
		await queueRun("run-newer", "conv-1");
		await queueRun("run-older", "conv-2");
		await backdateRun("run-older", 5_000);

		const claimed = await claimNextRunTx(tdb.db, { workerId: "worker-1" });

		expect(claimed).toMatchObject({
			runId: "run-older",
			status: "running",
			lockedBy: "worker-1",
		});
		expect(claimed?.lockedUntil?.getTime()).toBeGreaterThan(Date.now());
		expect(claimed?.heartbeatAt).toBeInstanceOf(Date);
	});

	// PGlite is single-connection, so this exercises the claim CAS, not true
	// cross-connection FOR UPDATE SKIP LOCKED contention — that is covered by
	// the local-Postgres integration layer of the testing plan.
	it("never hands the same run to two claimants", async () => {
		await queueRun("run-1", "conv-1");
		await queueRun("run-2", "conv-2");

		const first = await claimNextRunTx(tdb.db, { workerId: "worker-1" });
		const second = await claimNextRunTx(tdb.db, { workerId: "worker-2" });
		const third = await claimNextRunTx(tdb.db, { workerId: "worker-3" });

		expect(first).not.toBeNull();
		expect(second).not.toBeNull();
		expect(first?.runId).not.toBe(second?.runId);
		expect(third).toBeNull();
	});
});

/** Queue and claim one run so append/terminal tests start from a live claim. */
async function claimRun(
	runId: string,
	conversationId: string,
	workerId: string,
) {
	await queueRun(runId, conversationId);
	await backdateRun(runId, 5_000);
	const claimed = await claimNextRunTx(tdb.db, { workerId });
	if (claimed?.runId !== runId) {
		throw new Error(`test setup claimed ${claimed?.runId}, wanted ${runId}`);
	}
	return claimed;
}

/** Force a claimed run's locked_until past, as if the worker stalled. */
async function expireOwnership(runId: string) {
	await tdb.db
		.update(runs)
		.set({ lockedUntil: sql`now() - interval '1 second'` })
		.where(eq(runs.runId, runId));
}

async function readEvents(runId: string) {
	return await tdb.db
		.select()
		.from(runEvents)
		.where(eq(runEvents.runId, runId))
		.orderBy(runEvents.seq);
}

describe("appendRunEventTx", () => {
	it("allocates monotonic database-owned sequence numbers", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const first = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.AssistantText,
			payload: { messageId: "message-1", text: "hel" },
			appendClass: "model",
		});
		const second = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.AssistantText,
			payload: { messageId: "message-2", text: "lo" },
			appendClass: "model",
		});

		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.AssistantText],
			[2, RunEventType.AssistantText],
		]);
		expect(events[0]?.payload).toEqual({
			messageId: "message-1",
			text: "hel",
		});
	});

	it("rejects malformed known events without consuming a sequence number", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
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
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.Done,
				payload: { outcome: "done" },
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(InvalidRunEventError);
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("persists stable Assistant and correlated Tool identities in order", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		const events = [
			{
				type: RunEventType.AssistantMessageCompleted,
				payload: { messageId: "assistant-1", text: "I will check." },
			},
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
				runId: "run-1",
				workerId: "worker-1",
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

	it("rejects a model append on a run that is not running", async () => {
		await queueRun("run-1", "conv-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.AssistantText,
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects an append from a worker that does not own the run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-2",
				type: RunEventType.AssistantText,
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects a stale worker append after locked_until has passed", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.AssistantText,
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("rejects model appends after cancellation is requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.AssistantText,
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("sequences tool events with assistant text under the model class", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const toolUse = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.ToolUse,
			payload: { tool: "Bash", arguments: { command: "ls" }, truncated: false },
			appendClass: "model",
		});
		const toolResult = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.ToolResult,
			payload: {
				tool: "Bash",
				result: { exitCode: 0 },
				isError: false,
				truncated: false,
			},
			appendClass: "model",
		});
		const text = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.AssistantText,
			payload: { messageId: "message-1", text: "done" },
			appendClass: "model",
		});

		expect([toolUse.seq, toolResult.seq, text.seq]).toEqual([1, 2, 3]);
		expect((await readEvents("run-1")).map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.ToolUse],
			[2, RunEventType.ToolResult],
			[3, RunEventType.AssistantText],
		]);
	});

	// Tool events ride the same `model` append class as assistant text, so the
	// same fence rejects them once the run leaves `running`…
	it("rejects a tool-event model append after cancellation is requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.ToolUse,
				payload: {
					tool: "Read",
					arguments: { path: "notes.md" },
					truncated: false,
				},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	// …or the worker no longer owns it.
	it("rejects a tool-event append from a worker that lost ownership", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.ToolResult,
				payload: {
					tool: "Read",
					result: { preview: "…" },
					isError: false,
					truncated: true,
				},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("allows cancellation audit appends while running or cancel_requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const whileRunning = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "model_interrupt_requested",
			payload: {},
			appendClass: "cancellation",
		});
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));
		const whileCancelRequested = await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: "command_canceled",
			payload: {},
			appendClass: "cancellation",
		});

		expect(whileRunning.seq).toBe(1);
		expect(whileCancelRequested.seq).toBe(2);
	});

	it("still fences cancellation audit appends by lock deadline", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));
		await expireOwnership("run-1");

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: "command_canceled",
				payload: {},
				appendClass: "cancellation",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("transitionRunTerminalTx", () => {
	it("completes a running run and appends exactly one run_done event", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await appendRunEventTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			type: RunEventType.AssistantText,
			payload: { messageId: "message-1", text: "hi" },
			appendClass: "model",
		});

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		expect(run).toMatchObject({
			runId: "run-1",
			status: "done",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([
			[1, RunEventType.AssistantText],
			[2, "run_done"],
		]);
		expect(events[1]?.payload).toEqual({ outcome: "done" });
	});

	it("rejects a second terminal transition for the same run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "error",
				payload: { message: "boom" },
			}),
		).rejects.toBeInstanceOf(RunFenceError);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("refuses done once cancellation was requested; canceled wins", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "canceled",
		});
		expect(run.status).toBe("canceled");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_canceled"]);
	});

	it("refuses error once cancellation was requested", async () => {
		// "Do not overload `error` for user-initiated cancellation": after
		// cancel_requested the only legal terminal is canceled, even when the
		// SDK errors during the interrupt.
		await claimRun("run-1", "conv-1", "worker-1");
		await tdb.db
			.update(runs)
			.set({ status: "cancel_requested" })
			.where(eq(runs.runId, "run-1"));

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "error",
				payload: { message: "sdk exploded mid-interrupt" },
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});

	it("marks a running run as error with the error payload", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const run = await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "error",
			payload: { message: "sandbox died" },
		});

		expect(run.status).toBe("error");
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.type, e.payload])).toEqual([
			["run_error", { message: "sandbox died", outcome: "error" }],
		]);
	});

	it("rejects a terminal transition from a non-owner or expired ownership", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-2",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);

		await expireOwnership("run-1");
		await expect(
			transitionRunTerminalTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				status: "done",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
	});
});

describe("requestRunCancellationTx", () => {
	const ref = { runId: "run-1", userId: "user-1", conversationId: "conv-1" };

	it("cancels a queued run immediately and appends run_canceled", async () => {
		await queueRun("run-1", "conv-1");

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("canceled");
		if (result.outcome !== "canceled") throw new Error("unreachable");
		expect(result.run).toMatchObject({
			runId: "run-1",
			status: "canceled",
			lockedBy: null,
			lockedUntil: null,
		});
		expect(result.run.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => [e.seq, e.type])).toEqual([[1, "run_canceled"]]);
		expect(events[0]?.payload).toEqual({ outcome: "canceled" });
	});

	it("moves a running run to cancel_requested and leaves ownership intact", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("cancel_requested");
		if (result.outcome !== "cancel_requested") throw new Error("unreachable");
		expect(result.run.status).toBe("cancel_requested");
		expect(result.run.lockedBy).toBe("worker-1");
		expect(result.run.cancelRequestedAt).toBeInstanceOf(Date);
		// No terminal event yet: the owning worker appends run_canceled when it
		// actually terminalizes.
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("is idempotent while cancellation is already requested", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, ref);

		const again = await requestRunCancellationTx(tdb.db, ref);

		expect(again.outcome).toBe("cancel_requested");
		expect(await readEvents("run-1")).toEqual([]);
	});

	it("reports an already-terminal run without touching it", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		const result = await requestRunCancellationTx(tdb.db, ref);

		expect(result.outcome).toBe("already_terminal");
		if (result.outcome !== "already_terminal") throw new Error("unreachable");
		expect(result.run.status).toBe("done");
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_done"]);
	});

	it("reports not_found for missing or foreign runs", async () => {
		await queueRun("run-1", "conv-1");

		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				runId: "run-ghost",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				userId: "user-2",
			}),
		).toEqual({ outcome: "not_found" });
		expect(
			await requestRunCancellationTx(tdb.db, {
				...ref,
				conversationId: "conv-2",
			}),
		).toEqual({ outcome: "not_found" });
	});
});

describe("heartbeatRunTx", () => {
	it("extends the lock deadline for the owning worker", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		// Pull the deadline near expiry so the fixed-duration renewal is visible.
		await tdb.db
			.update(runs)
			.set({ lockedUntil: sql`now() + interval '1 second'` })
			.where(eq(runs.runId, "run-1"));

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).not.toBeNull();
		expect(renewed?.lockedUntil?.getTime()).toBeGreaterThan(
			Date.now() + 30_000,
		);
		expect(renewed?.heartbeatAt).toBeInstanceOf(Date);
	});

	it("lets the control loop observe a pending cancellation request", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed?.status).toBe("cancel_requested");
		expect(renewed?.cancelRequestedAt).toBeInstanceOf(Date);
	});

	it("does not renew for a worker that does not own the run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-2",
		});

		expect(renewed).toBeNull();
	});

	it("does not revive expired ownership", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).toBeNull();
	});

	it("does not renew a terminal run", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
			status: "done",
		});

		const renewed = await heartbeatRunTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(renewed).toBeNull();
	});
});

describe("markLiveStreamFailedTx", () => {
	it("marks an active Run only through its live ownership fence", async () => {
		await claimRun("run-1", "conv-1", "worker-1");

		expect(
			await markLiveStreamFailedTx(tdb.db, {
				runId: "run-1",
				workerId: "other-worker",
			}),
		).toEqual({ outcome: "fence_rejected" });

		const marked = await markLiveStreamFailedTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});
		expect(marked.outcome).toBe("marked");
		if (marked.outcome !== "marked") throw new Error("unreachable");
		expect(marked.run.status).toBe("running");
		expect(marked.run.liveStreamFailedAt).toBeInstanceOf(Date);
	});

	it("is idempotent for the owning worker without moving the timestamp", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		const first = await markLiveStreamFailedTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});
		if (first.outcome !== "marked") throw new Error("unreachable");

		const again = await markLiveStreamFailedTx(tdb.db, {
			runId: "run-1",
			workerId: "worker-1",
		});

		expect(again.outcome).toBe("already_failed");
		if (again.outcome !== "already_failed") throw new Error("unreachable");
		expect(again.run.liveStreamFailedAt).toEqual(first.run.liveStreamFailedAt);
	});

	it("rejects expired ownership but permits the monotonic null-to-time write after terminalization", async () => {
		await claimRun("run-expired", "conv-expired", "worker-1");
		await expireOwnership("run-expired");
		expect(
			await markLiveStreamFailedTx(tdb.db, {
				runId: "run-expired",
				workerId: "worker-1",
			}),
		).toEqual({ outcome: "fence_rejected" });

		await claimRun("run-terminal", "conv-terminal", "worker-1");
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-terminal",
			workerId: "worker-1",
			status: "done",
		});
		const marked = await markLiveStreamFailedTx(tdb.db, {
			runId: "run-terminal",
			workerId: "worker-1",
		});

		expect(marked.outcome).toBe("marked");
		if (marked.outcome !== "marked") throw new Error("unreachable");
		expect(marked.run).toMatchObject({ status: "done" });
		expect(marked.run.liveStreamFailedAt).toBeInstanceOf(Date);
		expect(
			(await readEvents("run-terminal")).map(({ payload }) => payload),
		).toEqual([{ outcome: "done" }]);
	});
});

describe("markStaleRunsTx", () => {
	it("terminalizes a stale running run as error with a run_error event", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "error"],
		]);
		expect(recovered[0]?.lockedBy).toBeNull();
		expect(recovered[0]?.terminalAt).toBeInstanceOf(Date);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
		expect(recovered[0]?.liveStreamFailedAt).toBeInstanceOf(Date);
	});

	it("terminalizes a stale cancel_requested run as canceled", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await requestRunCancellationTx(tdb.db, {
			runId: "run-1",
			userId: "user-1",
			conversationId: "conv-1",
		});
		await expireOwnership("run-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-1", "canceled"],
		]);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_canceled"]);
	});

	it("leaves queued runs and live claims alone", async () => {
		await queueRun("run-queued", "conv-1");
		await claimRun("run-live", "conv-2", "worker-1");

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered).toEqual([]);
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

	it("terminalizes old unclaimed queued runs as error", async () => {
		await queueRun("run-queued", "conv-1");
		await tdb.db
			.update(runs)
			.set({ createdAt: sql`now() - interval '2 minutes'` })
			.where(eq(runs.runId, "run-queued"));

		const recovered = await markStaleRunsTx(tdb.db);

		expect(recovered.map((r) => [r.runId, r.status])).toEqual([
			["run-queued", "error"],
		]);
		const events = await readEvents("run-queued");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("never double-terminalizes: a second sweep finds nothing", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");
		await markStaleRunsTx(tdb.db);

		const again = await markStaleRunsTx(tdb.db);

		expect(again).toEqual([]);
		const events = await readEvents("run-1");
		expect(events.map((e) => e.type)).toEqual(["run_error"]);
	});

	it("rejects the stale worker's appends once recovery has terminalized", async () => {
		await claimRun("run-1", "conv-1", "worker-1");
		await expireOwnership("run-1");
		await markStaleRunsTx(tdb.db);

		await expect(
			appendRunEventTx(tdb.db, {
				runId: "run-1",
				workerId: "worker-1",
				type: RunEventType.AssistantText,
				payload: {},
				appendClass: "model",
			}),
		).rejects.toBeInstanceOf(RunFenceError);
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
