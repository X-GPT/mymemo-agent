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
import type { ApiConfig } from "@/config/env";
import type { AppDeps } from "@/deps";
import type { LeaseRecord, LeaseRef, LeaseStore } from "@/features/lease-store";
import type { RequestLogger } from "@/features/streaming/logger";
import { ConversationBusyError } from "./errors";
import { SandboxLeaseManager } from "./sandbox-lease-manager";
import {
	type RunSandboxChatOptions,
	runSandboxChat,
} from "./sandbox-orchestration";
import * as proxyModule from "./sandbox-proxy";
import { createMockSandbox } from "./test-helpers";

type ForwardOpts = Parameters<typeof proxyModule.forwardChatTurnToSandbox>[0];

const silentLogger = {
	info: () => {},
	error: () => {},
	warn: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as RequestLogger;

// Config is injected, not read from env — so the secret/url under test are fixed
// here and can't be perturbed by another test file or Bun's .env auto-load.
const config: ApiConfig = {
	sandboxProvider: "e2b",
	localSandboxDaemonUrl: "http://sandbox:8080",
	e2bTemplate: "test-template",
	llmTokenSecret: "test-llm-token-secret",
	gatewayPublicUrl: "https://gateway.test",
	logLevel: "info",
	workspaceStoreRoot: "/tmp/workspace-store-test",
	databaseUrl: "postgresql://test/mymemo_agent",
};

const DAEMON = {
	url: "http://daemon:8080",
	trafficAccessToken: "test-traffic-token",
};

/** Minimal in-memory {@link LeaseStore}, keyed like the Postgres composite PK. */
class FakeLeaseStore implements LeaseStore {
	readonly records = new Map<string, LeaseRecord>();
	private key(ref: LeaseRef) {
		return `${ref.userId}\0${ref.conversationId}`;
	}
	async get(ref: LeaseRef) {
		return this.records.get(this.key(ref)) ?? null;
	}
	async upsert(record: LeaseRecord) {
		this.records.set(this.key(record), { ...record });
	}
	async delete(ref: LeaseRef) {
		this.records.delete(this.key(ref));
	}
	async withClaim<T>(_ref: LeaseRef, fn: () => Promise<T>) {
		return { acquired: true, result: await fn() };
	}
}

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
		onAgentSessionId: async () => {},
		onSandboxId: async () => {},
		onDaemonStarted: async () => {},
		logger: silentLogger,
		...overrides,
	};
}

describe("runSandboxChat", () => {
	let createSandbox: ReturnType<typeof mock>;
	let connectSandbox: ReturnType<typeof mock>;
	let ensureSandboxDaemon: ReturnType<typeof mock>;
	let daemonEndpoint: ReturnType<typeof mock>;
	let setSandboxTimeout: ReturnType<typeof mock>;
	let killSandbox: ReturnType<typeof mock>;
	let cancelSandbox: ReturnType<typeof mock>;
	let hydrate: ReturnType<typeof mock>;
	let sync: ReturnType<typeof mock>;
	let forwardTurn: ReturnType<typeof spyOn>;
	let leaseStore: FakeLeaseStore;
	let deps: AppDeps;

	beforeEach(() => {
		// A fresh create returns sbx-123; reuse reattaches to the same id.
		createSandbox = mock(async () => createMockSandbox());
		connectSandbox = mock(async (sandboxId: string) => ({ sandboxId }));
		ensureSandboxDaemon = mock(async () => DAEMON);
		daemonEndpoint = mock(() => DAEMON);
		setSandboxTimeout = mock(async () => undefined);
		killSandbox = mock(async () => undefined);
		cancelSandbox = mock(async () => undefined);
		hydrate = mock(async () => undefined);
		sync = mock(async () => undefined);
		leaseStore = new FakeLeaseStore();

		const sandboxProvider = {
			createSandbox,
			connectSandbox,
			daemonEndpoint,
			setSandboxTimeout,
			ensureSandboxDaemon,
			killSandbox,
			cancelSandbox,
		};
		const workspaceStore = {
			hydrateConversationWorkspace: hydrate,
			syncConversationWorkspace: sync,
		};
		const leaseManager = new SandboxLeaseManager({
			// biome-ignore lint/suspicious/noExplicitAny: partial provider mock for the lease seam.
			sandboxProvider: sandboxProvider as any,
			leaseStore,
			// biome-ignore lint/suspicious/noExplicitAny: only hydrate/sync are used.
			workspaceStore: workspaceStore as any,
		});

		deps = {
			config,
			// biome-ignore lint/suspicious/noExplicitAny: orchestration only reads leaseManager + config.
			sandboxProvider: sandboxProvider as any,
			// biome-ignore lint/suspicious/noExplicitAny: orchestration no longer touches the store directly.
			workspaceStore: workspaceStore as any,
			leaseManager,
		} as unknown as AppDeps;

		// forwardChatTurnToSandbox stays a module import in runSandboxChat, so spy it.
		forwardTurn = spyOn(
			proxyModule,
			"forwardChatTurnToSandbox",
		).mockResolvedValue(undefined);
	});

	afterEach(() => {
		forwardTurn?.mockRestore();
		mock.restore();
	});

	it("leases a sandbox, forwards the turn to its daemon, and returns completed", async () => {
		const result = await runSandboxChat(deps, makeOptions());

		expect(result).toEqual({ status: "completed" });
		expect(createSandbox).toHaveBeenCalledTimes(1);
		expect(ensureSandboxDaemon).toHaveBeenCalledTimes(1);
		expect(forwardTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				daemonUrl: "http://daemon:8080",
				trafficAccessToken: "test-traffic-token",
			}),
		);
	});

	it("mints verifiable per-audience llm and doc tokens bound to the user, sandbox, and run", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.llm_base_url).toBe("https://gateway.test");
			expect(opts.turnRequest.doc_gateway_url).toBe("https://gateway.test");

			const llm = verifyLlmToken(
				opts.turnRequest.llm_token,
				"test-llm-token-secret",
				"llm",
			);
			expect(llm?.aud).toBe("llm");
			expect(llm?.userId).toBe("user-1");
			expect(llm?.sandboxId).toBe("sbx-123");
			expect(llm?.requestId).toBe(opts.turnRequest.request_id);
			expect(llm?.conversationId).toBe("conv-1");
			expect(llm?.runId).toBe("run-1");
			expect(
				verifyLlmToken(
					opts.turnRequest.llm_token,
					"test-llm-token-secret",
					"documents",
				),
			).toBeNull();

			const doc = verifyLlmToken(
				opts.turnRequest.doc_token,
				"test-llm-token-secret",
				"documents",
			);
			expect(doc?.aud).toBe("documents");
			expect(doc?.userId).toBe("user-1");
			expect(doc?.runId).toBe("run-1");
			expect(
				verifyLlmToken(
					opts.turnRequest.doc_token,
					"test-llm-token-secret",
					"llm",
				),
			).toBeNull();
		});

		await runSandboxChat(deps, makeOptions());
	});

	it("signs the document scope into the doc token, not the llm token", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			const doc = verifyLlmToken(
				opts.turnRequest.doc_token,
				"test-llm-token-secret",
				"documents",
			);
			expect(doc?.scope).toBe("collection");
			expect(doc?.collectionId).toBe("col-1");
			const llm = verifyLlmToken(
				opts.turnRequest.llm_token,
				"test-llm-token-secret",
				"llm",
			);
			expect(llm?.scope).toBeUndefined();
			expect(llm?.collectionId).toBeUndefined();
		});

		await runSandboxChat(
			deps,
			makeOptions({ scope: "collection", collectionId: "col-1" }),
		);
	});

	it("propagates conversationId and runId into the daemon turn request", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.conversation_id).toBe("conv-42");
			expect(opts.turnRequest.run_id).toBe("run-99");
		});

		await runSandboxChat(
			deps,
			makeOptions({ conversationId: "conv-42", runId: "run-99" }),
		);
	});

	it("forwards agentSessionId as agent_session_id", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.agent_session_id).toBe("client-session");
		});

		await runSandboxChat(deps, makeOptions({ agentSessionId: "client-session" }));
	});

	it("omits agent_session_id when no agentSessionId provided", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.agent_session_id).toBeUndefined();
		});

		await runSandboxChat(deps, makeOptions({ agentSessionId: null }));
	});

	it("reuses one warm sandbox across consecutive turns in a conversation", async () => {
		await runSandboxChat(deps, makeOptions());
		await runSandboxChat(deps, makeOptions());

		expect(createSandbox).toHaveBeenCalledTimes(1);
		expect(connectSandbox).toHaveBeenCalledTimes(1);
		expect(ensureSandboxDaemon).toHaveBeenCalledTimes(1);
	});

	it("does not share a sandbox across conversations", async () => {
		await runSandboxChat(deps, makeOptions({ conversationId: "conv-1" }));
		await runSandboxChat(deps, makeOptions({ conversationId: "conv-2" }));

		expect(createSandbox).toHaveBeenCalledTimes(2);
	});

	it("keeps the sandbox warm on release — it does not kill it", async () => {
		await runSandboxChat(deps, makeOptions());

		expect(killSandbox).not.toHaveBeenCalled();
		expect(
			await leaseStore.get({ userId: "user-1", conversationId: "conv-1" }),
		).not.toBeNull();
	});

	it("rejects a concurrent turn for the same conversation as busy", async () => {
		let releaseForward: () => void = () => {};
		const forwardGate = new Promise<void>((resolve) => {
			releaseForward = resolve;
		});
		forwardTurn.mockImplementation(() => forwardGate);

		const first = runSandboxChat(deps, makeOptions());
		const second = runSandboxChat(deps, makeOptions());

		await expect(second).rejects.toBeInstanceOf(ConversationBusyError);
		expect(createSandbox).toHaveBeenCalledTimes(1);

		releaseForward();
		await first;
	});

	it("invokes onSandboxId with the leased sandbox id", async () => {
		const received: string[] = [];
		await runSandboxChat(
			deps,
			makeOptions({
				onSandboxId: async (id) => {
					received.push(id);
				},
			}),
		);

		expect(received).toEqual(["sbx-123"]);
	});

	it("invokes onDaemonStarted after the daemon is up and before forwarding the turn", async () => {
		const order: string[] = [];
		ensureSandboxDaemon.mockImplementation(async () => {
			order.push("ensureDaemon");
			return DAEMON;
		});
		forwardTurn.mockImplementation(async () => {
			order.push("forward");
		});

		await runSandboxChat(
			deps,
			makeOptions({
				onDaemonStarted: async () => {
					order.push("daemonStarted");
				},
			}),
		);

		expect(order).toEqual(["ensureDaemon", "daemonStarted", "forward"]);
	});

	it("surfaces daemon-emitted session id via onAgentSessionId callback", async () => {
		const received: string[] = [];
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			await opts.onSessionId("new-session-123");
		});

		await runSandboxChat(
			deps,
			makeOptions({
				onAgentSessionId: async (id) => {
					received.push(id);
				},
			}),
		);

		expect(received).toEqual(["new-session-123"]);
	});

	it("maps general scope to global", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.scope_type).toBe("global");
		});

		await runSandboxChat(deps, makeOptions({ scope: "general" }));
	});

	it("maps collection scope correctly", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.scope_type).toBe("collection");
			expect(opts.turnRequest.collection_id).toBe("col-1");
		});

		await runSandboxChat(
			deps,
			makeOptions({ scope: "collection", collectionId: "col-1" }),
		);
	});

	it("maps document scope correctly", async () => {
		forwardTurn.mockImplementation(async (opts: ForwardOpts) => {
			expect(opts.turnRequest.scope_type).toBe("document");
			expect(opts.turnRequest.summary_id).toBe("sum-1");
		});

		await runSandboxChat(
			deps,
			makeOptions({ scope: "document", summaryId: "sum-1" }),
		);
	});

	it("hydrates the durable workspace before forwarding the turn", async () => {
		const order: string[] = [];
		hydrate.mockImplementation(async () => {
			order.push("hydrate");
		});
		forwardTurn.mockImplementation(async () => {
			order.push("forward");
		});

		await runSandboxChat(
			deps,
			makeOptions({ userId: "user-1", conversationId: "conv-1" }),
		);

		expect(hydrate).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
		expect(order).toEqual(["hydrate", "forward"]);
	});

	it("syncs the durable workspace after a successful turn", async () => {
		await runSandboxChat(
			deps,
			makeOptions({ userId: "user-1", conversationId: "conv-1" }),
		);

		expect(sync).toHaveBeenCalledWith({
			userId: "user-1",
			conversationId: "conv-1",
		});
	});

	it("syncs the durable workspace even when the turn fails", async () => {
		forwardTurn.mockRejectedValue(new Error("daemon unreachable"));

		await expect(runSandboxChat(deps, makeOptions())).rejects.toThrow(
			"daemon unreachable",
		);

		expect(sync).toHaveBeenCalled();
	});

	it("does not let a sync failure mask the turn result", async () => {
		sync.mockRejectedValue(new Error("durable store down"));

		const result = await runSandboxChat(deps, makeOptions());

		expect(result).toEqual({ status: "completed" });
	});

	it("propagates proxy errors", async () => {
		forwardTurn.mockRejectedValue(new Error("daemon unreachable"));

		await expect(runSandboxChat(deps, makeOptions())).rejects.toThrow(
			"daemon unreachable",
		);
	});
});
