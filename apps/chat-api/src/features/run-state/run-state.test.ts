import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createLocalWorkspaceStore,
	type RunEvent,
	type RunRef,
} from "@/features/workspace-store";
import { encodeUserSegment } from "@/features/workspace-store/paths";
import {
	createRun,
	normalizeRunError,
	type RunEventSink,
	RunEventType,
} from "./run-state";

const ref: RunRef = { userId: "user-1", runId: "run-1" };

/** In-memory sink that records every (ref, event) pair in append order. */
function fakeSink() {
	const events: { ref: RunRef; event: RunEvent }[] = [];
	const sink: RunEventSink = {
		async appendRunEvent(r, event) {
			events.push({ ref: r, event });
		},
	};
	return {
		sink,
		events,
		types: () => events.map((e) => e.event.type),
		messages: () => events.map((e) => e.event),
	};
}

// Deterministic monotonic clock so timestamps are assertable.
function fakeClock() {
	let n = 0;
	return () => `2026-06-20T00:00:0${n++}.000Z`;
}

describe("run-state lifecycle", () => {
	it("records a full successful lifecycle in order", async () => {
		const { sink, events, messages } = fakeSink();
		const run = await createRun({
			sink,
			ref,
			conversationId: "conv-1",
			now: fakeClock(),
		});

		await run.recordSandboxLeased("sbx-1");
		await run.recordDaemonStarted();
		await run.recordAgentEvent({ text: "hello" });
		await run.markRunCompleted();

		expect(run.status).toBe("completed");
		// Ordered event stream: start, sandbox lease, daemon start, agent event,
		// completion. The start event carries run identity, every event is
		// timestamped, and passthrough fields survive verbatim.
		expect(messages()).toMatchObject([
			{
				type: RunEventType.Started,
				conversationId: "conv-1",
				userId: "user-1",
				runId: "run-1",
				at: "2026-06-20T00:00:00.000Z",
			},
			{ type: RunEventType.SandboxLeased, sandboxId: "sbx-1" },
			{ type: RunEventType.DaemonStarted },
			{ type: RunEventType.AgentEvent, text: "hello" },
			{ type: RunEventType.Completed },
		]);
		// Every event is written under the run's ref.
		expect(events.every((e) => e.ref === ref)).toBe(true);
	});

	it("records a failed lifecycle with a normalized error message", async () => {
		const { sink, messages } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		await run.recordSandboxLeased("sbx-1");
		await run.markRunFailed(new Error("daemon unreachable"));

		expect(run.status).toBe("failed");
		expect(messages()).toMatchObject([
			{ type: RunEventType.Started },
			{ type: RunEventType.SandboxLeased, sandboxId: "sbx-1" },
			{ type: RunEventType.Failed, error: "daemon unreachable" },
		]);
	});

	it("keeps the category label authoritative when payload carries its own type", async () => {
		const { sink, messages } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// Daemon payloads have their own `type` (e.g. "text_delta"); it must not
		// clobber the run-event category (or NDJSON consumers can't filter by it),
		// but it is preserved under `agentEventType` so the stream can be replayed.
		await run.recordAgentEvent({ type: "text_delta", text: "hi" });

		expect(messages()).toMatchObject([
			{ type: RunEventType.Started },
			{
				type: RunEventType.AgentEvent,
				agentEventType: "text_delta",
				text: "hi",
			},
		]);
	});

	it("keeps the server timestamp authoritative when payload carries its own `at`", async () => {
		const { sink, messages } = fakeSink();
		const run = await createRun({
			sink,
			ref,
			conversationId: "conv-1",
			now: fakeClock(),
		});

		await run.recordAgentEvent({ at: "PAYLOAD-TIME", text: "hi" });

		// The agent event is stamped with the run clock, not the payload's `at`.
		expect(messages()).toMatchObject([
			{ type: RunEventType.Started, at: "2026-06-20T00:00:00.000Z" },
			{
				type: RunEventType.AgentEvent,
				at: "2026-06-20T00:00:01.000Z",
				text: "hi",
			},
		]);
	});

	it("records a non-empty error message even when failed with no value", async () => {
		const { sink, messages } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// e.g. `throw undefined` or a promise rejected with no reason.
		await run.markRunFailed(undefined);

		expect(run.status).toBe("failed");
		expect(messages()).toMatchObject([
			{ type: RunEventType.Started },
			{ type: RunEventType.Failed, error: "undefined" },
		]);
	});

	it("records a canceled lifecycle", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		await run.markRunCanceled();

		expect(types()).toEqual([RunEventType.Started, RunEventType.Canceled]);
		expect(run.status).toBe("canceled");
	});
});

describe("run-state cancellation (idempotent)", () => {
	// Acceptance: cancellation covers an active run, an already-completed run, an
	// already-failed run, and an already-canceled run. Only the active case
	// transitions; every other call is a safe no-op so a late cancel signal that
	// races the run's natural outcome never throws or double-records.

	it("cancels an active run and records exactly one run_canceled", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		const outcome = await run.cancel();

		expect(outcome).toEqual({ transitioned: true, status: "canceled" });
		expect(run.status).toBe("canceled");
		expect(types()).toEqual([RunEventType.Started, RunEventType.Canceled]);
	});

	it("is idempotent: a repeated cancel is a no-op with no duplicate event", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		await run.cancel();
		const second = await run.cancel();

		expect(second).toEqual({ transitioned: false, status: "canceled" });
		expect(run.status).toBe("canceled");
		// Still exactly one canceled record — the second cancel wrote nothing.
		expect(types()).toEqual([RunEventType.Started, RunEventType.Canceled]);
	});

	it("does not cancel an already-completed run (cancel lost the race)", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });
		await run.markRunCompleted();

		const outcome = await run.cancel();

		expect(outcome).toEqual({ transitioned: false, status: "completed" });
		expect(run.status).toBe("completed");
		expect(types()).toEqual([RunEventType.Started, RunEventType.Completed]);
	});

	it("does not cancel an already-failed run (cancel lost the race)", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });
		await run.markRunFailed(new Error("boom"));

		const outcome = await run.cancel();

		expect(outcome).toEqual({ transitioned: false, status: "failed" });
		expect(run.status).toBe("failed");
		expect(types()).toEqual([RunEventType.Started, RunEventType.Failed]);
	});

	it("stays running and is retryable when the cancel write fails", async () => {
		let failNext = true;
		const persisted: RunEvent[] = [];
		const sink: RunEventSink = {
			async appendRunEvent(_ref, event) {
				if (failNext && event.type === RunEventType.Canceled) {
					failNext = false;
					throw new Error("ENOSPC");
				}
				persisted.push(event);
			},
		};
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// First cancel write rejects; status must not advance, so a retry works.
		await expect(run.cancel()).rejects.toThrow(/ENOSPC/);
		expect(run.status).toBe("running");

		const outcome = await run.cancel();
		expect(outcome).toEqual({ transitioned: true, status: "canceled" });
		expect(persisted.map((e) => e.type)).toEqual([
			RunEventType.Started,
			RunEventType.Canceled,
		]);
	});
});

describe("run-state terminal guards", () => {
	it("rejects a second terminal transition", async () => {
		const { sink } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });
		await run.markRunCompleted();

		await expect(run.markRunFailed(new Error("late"))).rejects.toThrow(
			/already completed/,
		);
		await expect(run.markRunCanceled()).rejects.toThrow(/already completed/);
		// Status is unchanged by the rejected transitions.
		expect(run.status).toBe("completed");
	});

	it("rejects events appended after a terminal transition", async () => {
		const { sink } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });
		await run.markRunCanceled();

		await expect(run.recordDaemonStarted()).rejects.toThrow(
			/Cannot append .* to a canceled run/,
		);
	});

	it("rejects lifecycle-owned event types from the generic appendRunEvent primitive", async () => {
		const { sink, types } = fakeSink();
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// Start and the terminal types are owned by createRun / markRun*; appending
		// them out of band would let a run record a duplicate start or an outcome
		// without advancing the state machine.
		for (const t of [
			RunEventType.Started,
			RunEventType.Completed,
			RunEventType.Failed,
			RunEventType.Canceled,
		]) {
			await expect(run.appendRunEvent({ type: t })).rejects.toThrow(
				/Cannot append lifecycle-owned event/,
			);
		}
		// The run is untouched: still running, exactly one start record persisted.
		expect(run.status).toBe("running");
		expect(types()).toEqual([RunEventType.Started]);
	});
});

describe("run-state durability and ordering", () => {
	it("stays running and is retryable when the terminal write fails", async () => {
		let failNext = true;
		const persisted: RunEvent[] = [];
		const sink: RunEventSink = {
			async appendRunEvent(_ref, event) {
				if (failNext && event.type === RunEventType.Failed) {
					failNext = false;
					throw new Error("ENOSPC");
				}
				persisted.push(event);
			},
		};
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// First terminal write rejects; status must not advance, so a retry works.
		await expect(run.markRunFailed("boom")).rejects.toThrow(/ENOSPC/);
		expect(run.status).toBe("running");

		await run.markRunFailed("boom");
		expect(run.status).toBe("failed");
		expect(persisted.map((e) => e.type)).toEqual([
			RunEventType.Started,
			RunEventType.Failed,
		]);
	});

	it("serializes a slow append ahead of a terminal marker (no log after terminal)", async () => {
		const order: string[] = [];
		const sink: RunEventSink = {
			async appendRunEvent(_ref, event) {
				// Make the first intermediate append slow so a non-awaited terminal
				// marker would, without serialization, race ahead of it.
				if (event.type === RunEventType.DaemonStarted) {
					await new Promise((r) => setTimeout(r, 20));
				}
				order.push(event.type);
			},
		};
		const run = await createRun({ sink, ref, conversationId: "conv-1" });

		// Fire both without awaiting the first.
		const appendP = run.recordDaemonStarted();
		const completeP = run.markRunCompleted();
		await Promise.all([appendP, completeP]);

		expect(order).toEqual([
			RunEventType.Started,
			RunEventType.DaemonStarted,
			RunEventType.Completed,
		]);
		expect(run.status).toBe("completed");
	});
});

describe("normalizeRunError", () => {
	it("extracts the message from an Error", () => {
		expect(normalizeRunError(new Error("boom"))).toBe("boom");
	});

	it("passes a string through unchanged", () => {
		expect(normalizeRunError("plain failure")).toBe("plain failure");
	});

	it("serializes a non-Error, non-string value", () => {
		expect(normalizeRunError({ code: 500 })).toBe('{"code":500}');
	});

	// JSON.stringify yields `undefined` for these (not a string); the failed-run
	// contract requires a non-empty error string, so they must fall back to String().
	it("returns a non-empty string for values JSON.stringify drops", () => {
		expect(normalizeRunError(undefined)).toBe("undefined");
		expect(normalizeRunError(Symbol("x"))).toBe("Symbol(x)");
		for (const v of [undefined, Symbol("x"), () => {}]) {
			const out = normalizeRunError(v);
			expect(typeof out).toBe("string");
			expect(out.length).toBeGreaterThan(0);
		}
	});

	it("falls back to String() when JSON.stringify throws (BigInt)", () => {
		expect(normalizeRunError(12n)).toBe("12");
	});
});

describe("run-state persistence through WorkspaceStore (NDJSON)", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "run-state-test-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("persists run events as one JSON object per line", async () => {
		const store = createLocalWorkspaceStore(root);
		const run = await createRun({
			sink: store,
			ref,
			conversationId: "conv-1",
			now: fakeClock(),
		});
		await run.recordSandboxLeased("sbx-1");
		await run.markRunFailed("gateway 502");

		const file = join(
			root,
			"users",
			encodeUserSegment("user-1"),
			"runs",
			"run-1",
			"events.jsonl",
		);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((l) => JSON.parse(l))).toEqual([
			{
				at: "2026-06-20T00:00:00.000Z",
				type: "run_started",
				conversationId: "conv-1",
				userId: "user-1",
				runId: "run-1",
			},
			{
				at: "2026-06-20T00:00:01.000Z",
				type: "sandbox_leased",
				sandboxId: "sbx-1",
			},
			{
				at: "2026-06-20T00:00:02.000Z",
				type: "run_failed",
				error: "gateway 502",
			},
		]);
	});
});
