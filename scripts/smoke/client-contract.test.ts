import { describe, expect, it } from "bun:test";
import { createClientContractFixture } from "./client-contract";

describe("hard-cutover client contract", () => {
	it("appends provisional deltas and replaces them with the authoritative commit", () => {
		const client = createClientContractFixture();

		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 0,
				text: "provi",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 1,
				text: "sional",
			},
		});
		expect(client.snapshot()).toEqual({
			messages: [
				{ messageId: "message-1", text: "provisional", provisional: true },
			],
			toolEvents: [],
			terminal: undefined,
		});

		client.receive({
			id: "2",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-1",
				text: "authoritative",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 2,
				text: "late",
			},
		});

		expect(client.snapshot()).toEqual({
			messages: [
				{
					messageId: "message-1",
					text: "authoritative",
					provisional: false,
				},
			],
			toolEvents: [],
			terminal: undefined,
		});
	});

	it("creates commits without preview and reconciles multiple message ids independently", () => {
		const client = createClientContractFixture();

		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-1",
				deltaIndex: 0,
				text: "first preview",
			},
		});
		client.receive({
			event: "text_delta",
			data: {
				type: "text_delta",
				messageId: "message-2",
				deltaIndex: 0,
				text: "second preview",
			},
		});
		client.receive({
			id: "2",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-1",
				text: "first commit",
			},
		});
		client.receive({
			id: "3",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-2",
				text: "second commit",
			},
		});
		client.receive({
			id: "4",
			event: "text_commit",
			data: {
				type: "text_commit",
				messageId: "message-3",
				text: "third commit",
			},
		});

		expect(client.snapshot().messages).toEqual([
			{ messageId: "message-1", text: "first commit", provisional: false },
			{ messageId: "message-2", text: "second commit", provisional: false },
			{ messageId: "message-3", text: "third commit", provisional: false },
		]);
	});

	for (const terminal of ["done", "canceled", "error"] as const) {
		it(`clears uncommitted preview on ${terminal}`, () => {
			const client = createClientContractFixture();
			client.receive({
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "preview",
					deltaIndex: 0,
					text: "discard me",
				},
			});
			client.receive({
				id: "9",
				event: terminal,
				data:
					terminal === "error"
						? { type: "error", message: "Run failed" }
						: { type: terminal },
			});
			client.receive({
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "late-preview",
					deltaIndex: 0,
					text: "must not resurrect",
				},
			});

			expect(client.snapshot()).toEqual({
				messages: [],
				toolEvents: [],
				terminal,
			});
		});
	}

	it("records tool events as chronological items in arrival order", () => {
		const client = createClientContractFixture();

		client.receive({
			id: "2",
			event: "tool_use",
			data: {
				type: "tool_use",
				tool: "Bash",
				arguments: { command: "ls -la", cwd: "src", timeoutMs: 30_000 },
				truncated: false,
			},
		});
		client.receive({
			id: "3",
			event: "tool_result",
			data: {
				type: "tool_result",
				tool: "Bash",
				result: { exitCode: 0, stdout: "a.ts\n" },
				isError: false,
				truncated: false,
			},
		});
		client.receive({
			id: "4",
			event: "tool_result",
			data: {
				type: "tool_result",
				tool: "Bash",
				result: { message: "Tool failed" },
				isError: true,
				truncated: false,
			},
		});

		expect(client.snapshot().toolEvents).toEqual([
			{ kind: "tool_use", tool: "Bash" },
			{ kind: "tool_result", tool: "Bash", isError: false },
			{ kind: "tool_result", tool: "Bash", isError: true },
		]);
	});

	it("rejects cursorless or malformed tool frames", () => {
		const client = createClientContractFixture();

		// Tool events are durable-only: no live lane, so every frame must carry
		// its run-event cursor.
		expect(() =>
			client.receive({
				event: "tool_use",
				data: {
					type: "tool_use",
					tool: "Bash",
					arguments: {},
					truncated: false,
				},
			}),
		).toThrow("tool_use must carry a durable cursor");
		expect(() =>
			client.receive({
				id: "2",
				event: "tool_use",
				data: { type: "tool_use", arguments: {}, truncated: false },
			}),
		).toThrow("invalid tool_use frame");
		expect(() =>
			client.receive({
				id: "2",
				event: "tool_result",
				data: {
					type: "tool_result",
					tool: "Bash",
					result: "raw text",
					isError: false,
					truncated: false,
				},
			}),
		).toThrow("invalid tool_result frame");
	});

	it("ignores tool frames after the terminal outcome", () => {
		const client = createClientContractFixture();
		client.receive({ id: "9", event: "done", data: { type: "done" } });
		client.receive({
			id: "10",
			event: "tool_use",
			data: {
				type: "tool_use",
				tool: "Bash",
				arguments: {},
				truncated: false,
			},
		});

		expect(client.snapshot().toolEvents).toEqual([]);
	});

	it("rejects cursor-bearing preview and the former text-only durable delta", () => {
		const client = createClientContractFixture();

		expect(() =>
			client.receive({
				id: "2",
				event: "text_delta",
				data: {
					type: "text_delta",
					messageId: "message-1",
					deltaIndex: 0,
					text: "preview",
				},
			}),
		).toThrow("text_delta must be cursorless");
		expect(() =>
			client.receive({
				event: "text_delta",
				data: { type: "text_delta", text: "legacy durable message" },
			}),
		).toThrow("invalid text_delta frame");
		expect(() =>
			client.receive({
				id: "2",
				event: "assistant_text",
				data: { type: "assistant_text", text: "legacy alias" },
			}),
		).toThrow("unsupported client event assistant_text");
	});
});
