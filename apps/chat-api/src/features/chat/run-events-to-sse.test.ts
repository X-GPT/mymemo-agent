import { describe, expect, it } from "bun:test";
import { AGENT_EVENT_TYPE_FIELD, RunEventType } from "@/features/run-state";
import type { RunEvent } from "@/features/workspace-store";
import { runEventToClientEvents } from "./run-events-to-sse";

describe("runEventToClientEvents", () => {
	it("derives conversation_id then run_id from run_started", () => {
		const event: RunEvent = {
			type: RunEventType.Started,
			conversationId: "conv-1",
			userId: "user-1",
			runId: "run-1",
		};
		expect(runEventToClientEvents(event)).toEqual([
			{ type: "conversation_id", conversationId: "conv-1" },
			{ type: "run_id", runId: "run-1" },
		]);
	});

	it("derives sandbox_id from sandbox_leased", () => {
		expect(
			runEventToClientEvents({
				type: RunEventType.SandboxLeased,
				sandboxId: "sbx-1",
			}),
		).toEqual([{ type: "sandbox_id", sandboxId: "sbx-1" }]);
	});

	it("derives text_delta from a text_delta agent event", () => {
		expect(
			runEventToClientEvents({
				type: RunEventType.AgentEvent,
				[AGENT_EVENT_TYPE_FIELD]: "text_delta",
				text: "hello",
			}),
		).toEqual([{ type: "text_delta", text: "hello" }]);
	});

	it("derives agent_session_id from a session_id agent event", () => {
		expect(
			runEventToClientEvents({
				type: RunEventType.AgentEvent,
				[AGENT_EVENT_TYPE_FIELD]: "session_id",
				sessionId: "agent-sess-1",
			}),
		).toEqual([{ type: "agent_session_id", agentSessionId: "agent-sess-1" }]);
	});

	it("derives done from run_completed", () => {
		expect(runEventToClientEvents({ type: RunEventType.Completed })).toEqual([
			{ type: "done" },
		]);
	});

	it("derives error carrying the recorded message from run_failed", () => {
		expect(
			runEventToClientEvents({ type: RunEventType.Failed, error: "boom" }),
		).toEqual([{ type: "error", message: "boom" }]);
	});

	it("falls back to a generic error message when none was recorded", () => {
		expect(runEventToClientEvents({ type: RunEventType.Failed })).toEqual([
			{ type: "error", message: "Run failed" },
		]);
	});

	it("emits no frame for internal-only events", () => {
		expect(
			runEventToClientEvents({ type: RunEventType.DaemonStarted }),
		).toEqual([]);
		expect(runEventToClientEvents({ type: RunEventType.Canceled })).toEqual([]);
		// An unrecognized agent event discriminator carries no client frame.
		expect(
			runEventToClientEvents({
				type: RunEventType.AgentEvent,
				[AGENT_EVENT_TYPE_FIELD]: "heartbeat",
			}),
		).toEqual([]);
	});

	it("drops fields of the wrong shape rather than emitting a malformed frame", () => {
		expect(
			runEventToClientEvents({
				type: RunEventType.SandboxLeased,
				sandboxId: 42,
			}),
		).toEqual([]);
		expect(
			runEventToClientEvents({
				type: RunEventType.Started,
				runId: "run-1",
			}),
		).toEqual([{ type: "run_id", runId: "run-1" }]);
	});
});
