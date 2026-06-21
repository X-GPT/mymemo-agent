import { afterEach, describe, expect, it, mock } from "bun:test";

import { ConversationBusyError } from "./errors";
import { forwardChatTurnToSandbox, type TurnRequest } from "./sandbox-proxy";

function makeTurnRequest(overrides: Partial<TurnRequest> = {}): TurnRequest {
	return {
		request_id: "req-1",
		user_id: "user-1",
		conversation_id: "conv-1",
		run_id: "run-1",
		scope_type: "global",
		message: "hello",
		system_prompt: "you are helpful",
		llm_base_url: "https://gateway.test",
		doc_gateway_url: "https://gateway.test",
		llm_token: "test-token",
		doc_token: "test-doc-token",
		...overrides,
	};
}

function ndjsonBody(events: Array<Record<string, unknown>>): string {
	return `${events.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

describe("forwardChatTurnToSandbox", () => {
	afterEach(() => {
		mock.restore();
	});

	it("sends the e2b traffic access token header", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock((_url, init) => {
			const headers = new Headers((init as RequestInit).headers);
			expect(headers.get("e2b-traffic-access-token")).toBe("traffic-token");
			return Promise.resolve(
				new Response(ndjsonBody([{ type: "completed" }]), { status: 200 }),
			);
		}) as unknown as typeof fetch;

		try {
			await forwardChatTurnToSandbox({
				daemonUrl: "http://localhost:8080",
				trafficAccessToken: "traffic-token",
				turnRequest: makeTurnRequest(),
				onTextDelta: async () => {},
				onSessionId: async () => {},
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws ConversationBusyError on 409", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(null, { status: 409 })),
		) as unknown as typeof fetch;

		try {
			await expect(
				forwardChatTurnToSandbox({
					daemonUrl: "http://localhost:8080",
					trafficAccessToken: "traffic-token",
					turnRequest: makeTurnRequest(),
					onTextDelta: async () => {},
					onSessionId: async () => {},
				}),
			).rejects.toBeInstanceOf(ConversationBusyError);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws on non-ok response", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response("server error", { status: 500 })),
		) as unknown as typeof fetch;

		try {
			await expect(
				forwardChatTurnToSandbox({
					daemonUrl: "http://localhost:8080",
					trafficAccessToken: "traffic-token",
					turnRequest: makeTurnRequest(),
					onTextDelta: async () => {},
					onSessionId: async () => {},
				}),
			).rejects.toThrow("Daemon returned 500");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("parses text_delta events and calls onTextDelta", async () => {
		const body = ndjsonBody([
			{ type: "started", turn_id: "t1" },
			{ type: "text_delta", text: "hello " },
			{ type: "text_delta", text: "world" },
			{ type: "completed" },
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(body, { status: 200 })),
		) as unknown as typeof fetch;

		const deltas: string[] = [];

		try {
			await forwardChatTurnToSandbox({
				daemonUrl: "http://localhost:8080",
				trafficAccessToken: "traffic-token",
				turnRequest: makeTurnRequest(),
				onTextDelta: async (text) => {
					deltas.push(text);
				},
				onSessionId: async () => {},
			});

			expect(deltas).toEqual(["hello ", "world"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("awaits each handler so a slow text_delta does not reorder later events", async () => {
		// A slow first handler would let a later text_delta complete first if
		// the proxy didn't await — the recorded order would be ["fast", "slow"].
		const body = ndjsonBody([
			{ type: "started", turn_id: "t1" },
			{ type: "text_delta", text: "slow" },
			{ type: "text_delta", text: "fast" },
			{ type: "session_id", sessionId: "sess-1" },
			{ type: "completed" },
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(body, { status: 200 })),
		) as unknown as typeof fetch;

		const completionOrder: string[] = [];

		try {
			await forwardChatTurnToSandbox({
				daemonUrl: "http://localhost:8080",
				trafficAccessToken: "traffic-token",
				turnRequest: makeTurnRequest(),
				onTextDelta: async (text) => {
					if (text === "slow") {
						await new Promise((r) => setTimeout(r, 30));
					}
					completionOrder.push(text);
				},
				onSessionId: async (id) => {
					completionOrder.push(id);
				},
			});

			expect(completionOrder).toEqual(["slow", "fast", "sess-1"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("parses session_id events", async () => {
		const body = ndjsonBody([
			{ type: "started", turn_id: "t1" },
			{ type: "session_id", sessionId: "sess-abc" },
			{ type: "completed" },
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(body, { status: 200 })),
		) as unknown as typeof fetch;

		let capturedSessionId = "";

		try {
			await forwardChatTurnToSandbox({
				daemonUrl: "http://localhost:8080",
				trafficAccessToken: "traffic-token",
				turnRequest: makeTurnRequest(),
				onTextDelta: async () => {},
				onSessionId: async (id) => {
					capturedSessionId = id;
				},
			});

			expect(capturedSessionId).toBe("sess-abc");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("throws on failed event from daemon", async () => {
		const body = ndjsonBody([
			{ type: "started", turn_id: "t1" },
			{ type: "failed", message: "agent crashed" },
		]);

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(body, { status: 200 })),
		) as unknown as typeof fetch;

		try {
			await expect(
				forwardChatTurnToSandbox({
					daemonUrl: "http://localhost:8080",
					trafficAccessToken: "traffic-token",
					turnRequest: makeTurnRequest(),
					onTextDelta: async () => {},
					onSessionId: async () => {},
				}),
			).rejects.toThrow("agent crashed");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	it("ignores non-JSON lines", async () => {
		const body =
			"not json\n" +
			JSON.stringify({ type: "started", turn_id: "t1" }) +
			"\n" +
			JSON.stringify({ type: "text_delta", text: "ok" }) +
			"\n" +
			JSON.stringify({ type: "completed" }) +
			"\n";

		const originalFetch = globalThis.fetch;
		globalThis.fetch = mock(() =>
			Promise.resolve(new Response(body, { status: 200 })),
		) as unknown as typeof fetch;

		const deltas: string[] = [];

		try {
			await forwardChatTurnToSandbox({
				daemonUrl: "http://localhost:8080",
				trafficAccessToken: "traffic-token",
				turnRequest: makeTurnRequest(),
				onTextDelta: async (text) => {
					deltas.push(text);
				},
				onSessionId: async () => {},
			});

			expect(deltas).toEqual(["ok"]);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
