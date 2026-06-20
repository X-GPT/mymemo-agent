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
		await run.recordHydration({ documentId: "doc-1" });
		await run.markRunCompleted();

		expect(run.status).toBe("completed");
		// Ordered event stream: start, sandbox lease, daemon start, agent event,
		// hydration event, completion. The start event carries run identity, every
		// event is timestamped, and passthrough fields survive verbatim.
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
			{ type: RunEventType.Hydration, documentId: "doc-1" },
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
		// clobber the run-event category, or NDJSON consumers can't filter by it.
		await run.recordAgentEvent({ type: "text_delta", text: "hi" });

		expect(messages()).toMatchObject([
			{ type: RunEventType.Started },
			{ type: RunEventType.AgentEvent, text: "hi" },
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
