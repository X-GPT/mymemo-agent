import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import { verifyLlmToken } from "@mymemo/llm-token";
import { createMockSandbox } from "./test-helpers";

type RunSandboxChatOptions =
	import("./sandbox-orchestration").RunSandboxChatOptions;

import type { ChatLogger } from "@/features/chat/chat.logger";

const silentLogger = {
	info: () => {},
	error: () => {},
	warn: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as ChatLogger;

function makeOptions(
	overrides: Partial<RunSandboxChatOptions> = {},
): RunSandboxChatOptions {
	return {
		userId: "user-1",
		conversationId: "conv-1",
		runId: "run-1",
		query: "hello",
		scope: "general" as const,
		collectionId: null,
		summaryId: null,
		agentSessionId: null,
		onTextDelta: async () => {},
		onTextEnd: async () => {},
		onAgentSessionId: async () => {},
		onSandboxId: async () => {},
		logger: silentLogger,
		...overrides,
	};
}

describe("runSandboxChat", () => {
	let runSandboxChat: typeof import("./sandbox-orchestration").runSandboxChat;
	let singletonModule: typeof import("./singleton");
	let proxyModule: typeof import("./sandbox-proxy");
	let spyCreate: ReturnType<typeof spyOn>;
	let spyEnsureDaemon: ReturnType<typeof spyOn>;
	let spyForwardTurn: ReturnType<typeof spyOn>;
	let spyKill: ReturnType<typeof spyOn>;

	beforeEach(async () => {
		Bun.env.E2B_API_KEY = "test-e2b-key";
		Bun.env.DAEMON_AUTH_TOKEN = "test-daemon-auth-token";
		Bun.env.LLM_TOKEN_SECRET = "test-llm-token-secret";
		Bun.env.GATEWAY_PUBLIC_URL = "https://gateway.test";
		({ runSandboxChat } = await import("./sandbox-orchestration"));
		singletonModule = await import("./singleton");
		proxyModule = await import("./sandbox-proxy");

		const sandbox = createMockSandbox();
		spyCreate = spyOn(
			singletonModule.sandboxManager,
			"createSandbox",
		).mockResolvedValue(sandbox as unknown as import("e2b").Sandbox);
		spyEnsureDaemon = spyOn(
			singletonModule.sandboxManager,
			"ensureSandboxDaemon",
		).mockResolvedValue({
			url: "http://daemon:8080",
			authToken: "test-daemon-auth-token",
		});
		spyKill = spyOn(
			singletonModule.sandboxManager,
			"killSandbox",
		).mockResolvedValue(undefined);
	});

	afterEach(() => {
		spyCreate?.mockRestore();
		spyEnsureDaemon?.mockRestore();
		spyForwardTurn?.mockRestore();
		spyKill?.mockRestore();
		mock.restore();
	});

	it("forwards turn to daemon and returns completed", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockResolvedValue(undefined);

		const result = await runSandboxChat(makeOptions());

		expect(result).toEqual({ status: "completed" });
		expect(spyCreate).toHaveBeenCalled();
		expect(spyEnsureDaemon).toHaveBeenCalled();
		expect(spyForwardTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				daemonUrl: "http://daemon:8080",
				daemonAuthToken: "test-daemon-auth-token",
			}),
		);
	});

	it("mints a verifiable llm token bound to the user and sandbox, plus the gateway url", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.llm_base_url).toBe("https://gateway.test");
			expect(opts.turnRequest.doc_gateway_url).toBe("https://gateway.test");
			const verified = verifyLlmToken(
				opts.turnRequest.llm_token,
				"test-llm-token-secret",
			);
			expect(verified?.userId).toBe("user-1");
			expect(verified?.sandboxId).toBe("sbx-123");
			expect(verified?.requestId).toBe(opts.turnRequest.request_id);
		});

		await runSandboxChat(makeOptions());
	});

	it("propagates conversationId and runId into the daemon turn request", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.conversation_id).toBe("conv-42");
			expect(opts.turnRequest.run_id).toBe("run-99");
		});

		await runSandboxChat(
			makeOptions({ conversationId: "conv-42", runId: "run-99" }),
		);
	});

	it("forwards agentSessionId as agent_session_id", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.agent_session_id).toBe("client-session");
		});

		await runSandboxChat(makeOptions({ agentSessionId: "client-session" }));
	});

	it("omits agent_session_id when no agentSessionId provided", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.agent_session_id).toBeUndefined();
		});

		await runSandboxChat(makeOptions({ agentSessionId: null }));
	});

	it("always creates a fresh sandbox for the user", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockResolvedValue(undefined);

		await runSandboxChat(makeOptions());

		expect(spyCreate).toHaveBeenCalledWith("user-1", expect.anything());
		// Ephemeral: the sandbox is torn down once the turn completes.
		expect(spyKill).toHaveBeenCalled();
	});

	it("kills the sandbox even when the turn fails", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockRejectedValue(new Error("daemon unreachable"));

		await expect(runSandboxChat(makeOptions())).rejects.toThrow(
			"daemon unreachable",
		);

		expect(spyKill).toHaveBeenCalled();
	});

	it("invokes onSandboxId with the resolved sandbox id", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockResolvedValue(undefined);

		const received: string[] = [];
		await runSandboxChat(
			makeOptions({
				onSandboxId: async (id) => {
					received.push(id);
				},
			}),
		);

		expect(received).toEqual(["sbx-123"]);
	});

	it("surfaces daemon-emitted session id via onAgentSessionId callback", async () => {
		const received: string[] = [];
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			await opts.onSessionId("new-session-123");
		});

		await runSandboxChat(
			makeOptions({
				onAgentSessionId: async (id) => {
					received.push(id);
				},
			}),
		);

		expect(received).toEqual(["new-session-123"]);
	});

	it("maps general scope to global", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.scope_type).toBe("global");
		});

		await runSandboxChat(makeOptions({ scope: "general" }));
	});

	it("maps collection scope correctly", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.scope_type).toBe("collection");
			expect(opts.turnRequest.collection_id).toBe("col-1");
		});

		await runSandboxChat(
			makeOptions({ scope: "collection", collectionId: "col-1" }),
		);
	});

	it("maps document scope correctly", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockImplementation(async (opts) => {
			expect(opts.turnRequest.scope_type).toBe("document");
			expect(opts.turnRequest.summary_id).toBe("sum-1");
		});

		await runSandboxChat(
			makeOptions({ scope: "document", summaryId: "sum-1" }),
		);
	});

	it("propagates proxy errors", async () => {
		spyForwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockRejectedValue(new Error("daemon unreachable"));

		await expect(runSandboxChat(makeOptions())).rejects.toThrow(
			"daemon unreachable",
		);
	});
});
