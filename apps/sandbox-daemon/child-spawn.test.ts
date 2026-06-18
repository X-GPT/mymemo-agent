import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	spyOn,
} from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent } from "./child-spawn";
import {
	assertDurableStoreRoot,
	buildAgentSpawnArgv,
	spawnAgent,
} from "./child-spawn";

describe("assertDurableStoreRoot", () => {
	it("rejects a relative root (would resolve against the ephemeral agent cwd)", () => {
		expect(() => assertDurableStoreRoot("session-store")).toThrow(
			/absolute path/,
		);
	});

	it("rejects an ephemeral root that won't survive a sandbox recycle", () => {
		expect(() => assertDurableStoreRoot("/workspace")).toThrow(/ephemeral/);
		expect(() => assertDurableStoreRoot("/workspace/sessions")).toThrow(
			/ephemeral/,
		);
		expect(() => assertDurableStoreRoot("/tmp/sessions")).toThrow(/ephemeral/);
	});

	it("accepts a durable absolute root", () => {
		expect(() => assertDurableStoreRoot("/session-store")).not.toThrow();
		expect(() => assertDurableStoreRoot("/mnt/durable/sessions")).not.toThrow();
	});
});

describe("buildAgentSpawnArgv", () => {
	it("runs bun /workspace/agent.js directly, with no wrapper", () => {
		// The sandbox/container is the isolation boundary, so the agent runs
		// directly — there is no bwrap (or any other) wrapper around it.
		const argv = buildAgentSpawnArgv();
		expect(argv).toEqual(["bun", "/workspace/agent.js"]);
	});

	it("respects SANDBOX_BUN_PATH and SANDBOX_AGENT_PATH env overrides", () => {
		const original = {
			bun: process.env.SANDBOX_BUN_PATH,
			agent: process.env.SANDBOX_AGENT_PATH,
		};
		process.env.SANDBOX_BUN_PATH = "/custom/bun";
		process.env.SANDBOX_AGENT_PATH = "/custom/agent.js";
		try {
			expect(buildAgentSpawnArgv()).toEqual([
				"/custom/bun",
				"/custom/agent.js",
			]);
		} finally {
			process.env.SANDBOX_BUN_PATH = original.bun;
			process.env.SANDBOX_AGENT_PATH = original.agent;
		}
	});
});

describe("spawnAgent agent environment", () => {
	let spawnSpy: ReturnType<typeof spyOn> | undefined;
	let baseDir: string;
	let cwd: string;
	let claudeConfigDir: string;

	beforeEach(() => {
		// Model the conversation workspace: cwd is `<base>/work` and the SDK config
		// home is its sibling `<base>/claude-config` (the layout createConversation-
		// Workspace materializes). Both sit under baseDir and clean up together.
		baseDir = mkdtempSync(join(tmpdir(), "spawn-agent-"));
		cwd = join(baseDir, "work");
		claudeConfigDir = join(baseDir, "claude-config");
	});

	afterEach(() => {
		spawnSpy?.mockRestore();
		rmSync(baseDir, { recursive: true, force: true });
	});

	function fakeProc() {
		return {
			stdin: { write: () => {}, end: () => Promise.resolve() },
			stdout: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			exited: Promise.resolve(0),
		};
	}

	it("passes the gateway base url + bearer token and never a provider key", async () => {
		spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
			fakeProc() as unknown as ReturnType<typeof Bun.spawn>,
		);

		await spawnAgent({
			userQuery: "q",
			systemPrompt: "s",
			cwd,
			claudeConfigDir,
			llmBaseUrl: "https://gateway.example",
			docGatewayUrl: "https://docs.example",
			llmToken: "tok-123",
			docToken: "doc-456",
			onEvent: async () => {},
		});

		const call = spawnSpy.mock.calls[0] as [
			string[],
			{ env: Record<string, string> },
		];
		// The agent runs directly under bun, no wrapper.
		expect(call[0]).toEqual(["bun", "/workspace/agent.js"]);
		const env = call[1].env;
		expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
		expect(env.ANTHROPIC_AUTH_TOKEN).toBe("tok-123");
		// Document access uses its own gateway url + (aud: documents) token.
		expect(env.MYMEMO_DOC_GATEWAY_URL).toBe("https://docs.example");
		expect(env.MYMEMO_DOC_TOKEN).toBe("doc-456");
		// SDK config + transcripts are isolated per conversation in a sibling of
		// cwd (not the project `.claude`, not the shared ~/.claude).
		expect(env.CLAUDE_CONFIG_DIR).toBe(claudeConfigDir);
		// The whole point of the gateway: no provider key reaches the agent.
		expect("ANTHROPIC_API_KEY" in env).toBe(false);
	});

	it("forwards the session-store root + identity when configured, omits them otherwise", async () => {
		const storeRoot = join(
			process.cwd(),
			`.session-store-spawn-test-${Date.now()}`,
		);
		const originalRoot = process.env.AGENT_SESSION_STORE_ROOT;

		const writes: string[] = [];
		const capturingProc = () => ({
			stdin: {
				write: (s: string) => writes.push(s),
				end: () => Promise.resolve(),
			},
			stdout: new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			}),
			stderr: new ReadableStream<Uint8Array>({
				start(c) {
					c.close();
				},
			}),
			exited: Promise.resolve(0),
		});

		try {
			process.env.AGENT_SESSION_STORE_ROOT = storeRoot;
			spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
				capturingProc() as unknown as ReturnType<typeof Bun.spawn>,
			);

			await spawnAgent({
				userQuery: "q",
				systemPrompt: "s",
				cwd,
				claudeConfigDir,
				userId: "member-abc",
				conversationId: "conv-1",
				llmBaseUrl: "https://gateway.example",
				docGatewayUrl: "https://docs.example",
				llmToken: "tok",
				docToken: "doc",
				onEvent: async () => {},
			});

			const call = spawnSpy.mock.calls[0] as [
				string[],
				{ env: Record<string, string> },
			];
			// Root is forwarded to the agent process so it builds a SessionStore.
			expect(call[1].env.AGENT_SESSION_STORE_ROOT).toBe(storeRoot);
			// Identity is threaded through the stdin config for key derivation.
			const config = JSON.parse(writes.join(""));
			expect(config.userId).toBe("member-abc");
			expect(config.conversationId).toBe("conv-1");
		} finally {
			if (originalRoot === undefined)
				delete process.env.AGENT_SESSION_STORE_ROOT;
			else process.env.AGENT_SESSION_STORE_ROOT = originalRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});

	it("omits the session-store root when identity is missing, even if configured", async () => {
		const storeRoot = join(
			process.cwd(),
			`.session-store-spawn-test-noid-${Date.now()}`,
		);
		const originalRoot = process.env.AGENT_SESSION_STORE_ROOT;
		try {
			process.env.AGENT_SESSION_STORE_ROOT = storeRoot;
			spawnSpy = spyOn(Bun, "spawn").mockReturnValue(
				fakeProc() as unknown as ReturnType<typeof Bun.spawn>,
			);

			await spawnAgent({
				userQuery: "q",
				systemPrompt: "s",
				cwd,
				claudeConfigDir,
				// No userId/conversationId — mirroring must stay off.
				llmBaseUrl: "https://gateway.example",
				docGatewayUrl: "https://docs.example",
				llmToken: "tok",
				docToken: "doc",
				onEvent: async () => {},
			});

			const call = spawnSpy.mock.calls[0] as [
				string[],
				{ env: Record<string, string> },
			];
			expect("AGENT_SESSION_STORE_ROOT" in call[1].env).toBe(false);
		} finally {
			if (originalRoot === undefined)
				delete process.env.AGENT_SESSION_STORE_ROOT;
			else process.env.AGENT_SESSION_STORE_ROOT = originalRoot;
			rmSync(storeRoot, { recursive: true, force: true });
		}
	});
});

describe("spawnAgent idle timeout", () => {
	// Real-subprocess tests: tiny fixture scripts stand in for agent.js, run
	// directly under bun (no bwrap wrapper), so we exercise the actual Bun.spawn +
	// NDJSON + watchdog wiring rather than mocking it.
	let tmpDir: string;
	const fixtures: Record<string, string> = {};

	const ENV_VARS = [
		"SANDBOX_AGENT_PATH",
		"SANDBOX_AGENT_IDLE_TIMEOUT_MS",
		"SANDBOX_AGENT_MAX_TURN_MS",
	];
	const originalEnv: Record<string, string | undefined> = {};

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "child-spawn-"));
		// makeInput models the conversation workspace under tmpDir: cwd is
		// `<tmpDir>/work` and the config home `<tmpDir>/claude-config`. Neither is
		// bound or chdir'd into, so neither needs to exist on disk.

		// Agent that consumes stdin then hangs (idle forever).
		fixtures.agentHang = join(tmpDir, "agent-hang.ts");
		writeFileSync(
			fixtures.agentHang,
			`for await (const _ of process.stdin) {}\nawait new Promise(() => {});\n`,
		);

		// Agent that emits 6 text_delta events 500ms apart, then completes.
		// Total span ~2.5s exceeds the 2s idle window used in the test, so it
		// only survives if every event re-arms the timer; the 500ms gaps stay
		// far below the window.
		fixtures.agentSlow = join(tmpDir, "agent-slow.ts");
		writeFileSync(
			fixtures.agentSlow,
			`for await (const _ of process.stdin) {}\nfor (let i = 0; i < 6; i++) {\n  process.stdout.write(JSON.stringify({ type: "text_delta", text: "tick" }) + "\\n");\n  await new Promise((r) => setTimeout(r, 500));\n}\nprocess.stdout.write(JSON.stringify({ type: "completed" }) + "\\n");\nprocess.exit(0);\n`,
		);

		// Agent that emits ONLY heartbeats (no text) 500ms apart for ~2.5s, then
		// completes. Mirrors agentSlow but for the liveness path: tool execution
		// is silent on stdout, so this is what keeps a long healthy tool from
		// tripping the watchdog. With the 2s window it survives only if every
		// heartbeat re-arms the timer.
		fixtures.agentHeartbeat = join(tmpDir, "agent-heartbeat.ts");
		writeFileSync(
			fixtures.agentHeartbeat,
			`for await (const _ of process.stdin) {}\nfor (let i = 0; i < 6; i++) {\n  process.stdout.write(JSON.stringify({ type: "heartbeat" }) + "\\n");\n  await new Promise((r) => setTimeout(r, 500));\n}\nprocess.stdout.write(JSON.stringify({ type: "completed" }) + "\\n");\nprocess.exit(0);\n`,
		);

		// Agent that heartbeats every 200ms forever and never completes —
		// stands in for a tool that hangs but keeps the turn "alive". The idle
		// watchdog can never fire (heartbeats keep re-arming it); only the
		// absolute per-turn ceiling can stop it.
		fixtures.agentHeartbeatForever = join(tmpDir, "agent-heartbeat-forever.ts");
		writeFileSync(
			fixtures.agentHeartbeatForever,
			`for await (const _ of process.stdin) {}\nsetInterval(() => {\n  process.stdout.write(JSON.stringify({ type: "heartbeat" }) + "\\n");\n}, 200);\nawait new Promise(() => {});\n`,
		);

		// Agent that emits completed, closes stdout, then lingers forever —
		// reproduces the teardown race: the read loop ends but the process
		// never exits, so only the still-armed watchdog unblocks the wait.
		fixtures.agentLinger = join(tmpDir, "agent-linger.ts");
		writeFileSync(
			fixtures.agentLinger,
			`import { closeSync } from "node:fs";\nfor await (const _ of process.stdin) {}\nprocess.stdout.write(JSON.stringify({ type: "completed" }) + "\\n");\nawait new Promise((r) => setTimeout(r, 50));\ncloseSync(1);\nawait new Promise(() => {});\n`,
		);

		for (const key of ENV_VARS) originalEnv[key] = process.env[key];
	});

	afterAll(() => {
		for (const key of ENV_VARS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function makeInput(onEvent: (e: AgentEvent) => void) {
		return {
			userQuery: "test",
			systemPrompt: "test",
			cwd: join(tmpDir, "work"),
			claudeConfigDir: join(tmpDir, "claude-config"),
			llmBaseUrl: "https://gateway.example",
			docGatewayUrl: "https://docs.example",
			llmToken: "tok-test",
			docToken: "doc-test",
			onEvent,
		};
	}

	it("kills the child and emits failed when no events arrive", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentHang;
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = "200";

		const events: AgentEvent[] = [];
		const start = Date.now();
		await spawnAgent(makeInput((e) => events.push(e)));
		const elapsed = Date.now() - start;

		// 200ms timeout + spawn/teardown overhead. Cap at 5s to catch hangs.
		expect(elapsed).toBeLessThan(5_000);
		const failed = events.find((e) => e.type === "failed");
		expect(failed).toBeDefined();
		if (failed?.type === "failed") {
			expect(failed.message).toContain("idle timeout");
			expect(failed.message).toContain("200");
		}
	});

	it("does not fire while events keep arriving (timer resets)", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentSlow;
		// 2s idle window: generous enough to absorb bun's cold start (~900ms
		// observed) before the first event, while the fixture's ~2.5s total
		// span exceeds it — so passing proves the timer resets per event.
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = "2000";

		const events: AgentEvent[] = [];
		const result = await spawnAgent(makeInput((e) => events.push(e)));

		expect(result.exitCode).toBe(0);
		expect(events.find((e) => e.type === "failed")).toBeUndefined();
		const deltas = events.filter((e) => e.type === "text_delta");
		expect(deltas.length).toBe(6);
	}, 15_000);

	it("kills a lingering child after completed without a spurious failed", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentLinger;
		// Same 2s window as above to absorb bun's cold start before `completed`.
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = "2000";

		const events: AgentEvent[] = [];
		const start = Date.now();
		const result = await spawnAgent(makeInput((e) => events.push(e)));
		const elapsed = Date.now() - start;

		// The watchdog must bound the wait on the never-exiting child...
		expect(elapsed).toBeLessThan(10_000);
		expect(result.exitCode).not.toBe(0);
		// ...without reporting a failure for an answer that fully streamed.
		expect(events.find((e) => e.type === "completed")).toBeDefined();
		expect(events.find((e) => e.type === "failed")).toBeUndefined();
	}, 15_000);

	// Regression for the watchdog bug: a long, text-silent gap that is bridged
	// only by `heartbeat` events (the liveness a tool emits while executing)
	// must NOT trip the watchdog, even though no token ever streams.
	it("treats heartbeats as liveness: a silent-but-beating tool survives", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentHeartbeat;
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = "2000";
		delete process.env.SANDBOX_AGENT_MAX_TURN_MS; // default ceiling, won't fire

		const events: AgentEvent[] = [];
		const result = await spawnAgent(makeInput((e) => events.push(e)));

		expect(result.exitCode).toBe(0);
		expect(events.find((e) => e.type === "failed")).toBeUndefined();
		// No text was ever emitted — survival is due to heartbeats alone.
		expect(events.find((e) => e.type === "text_delta")).toBeUndefined();
		expect(events.filter((e) => e.type === "heartbeat").length).toBe(6);
		expect(events.find((e) => e.type === "completed")).toBeDefined();
	}, 15_000);

	// The honest residual: a tool that hangs forever keeps heartbeating, so the
	// idle watchdog can't see it. The absolute per-turn ceiling is the backstop.
	it("kills a forever-beating turn via the absolute ceiling, not the idle timer", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentHeartbeatForever;
		// Idle window large so it never fires; ceiling small so it does. The
		// elapsed-time assertion proves the ceiling — not the idle timer — killed it.
		process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = "30000";
		process.env.SANDBOX_AGENT_MAX_TURN_MS = "1500";

		const events: AgentEvent[] = [];
		const start = Date.now();
		const result = await spawnAgent(makeInput((e) => events.push(e)));
		const elapsed = Date.now() - start;

		// Ceiling (1500ms) fired well before the idle window (30000ms).
		expect(elapsed).toBeLessThan(10_000);
		expect(result.exitCode).not.toBe(0);
		// Heartbeats were flowing the whole time — liveness was never the issue.
		expect(events.some((e) => e.type === "heartbeat")).toBe(true);
		const failed = events.find((e) => e.type === "failed");
		expect(failed).toBeDefined();
		if (failed?.type === "failed") {
			expect(failed.message).toContain("max duration");
			expect(failed.message).toContain("1500");
		}
	}, 15_000);

	// A malformed SANDBOX_AGENT_IDLE_TIMEOUT_MS must fall back to the default,
	// not become NaN/0 — setTimeout(fn, NaN|0) fires immediately and would
	// SIGKILL every turn at spawn.
	it("falls back to the default idle timeout on a malformed env value", async () => {
		process.env.SANDBOX_AGENT_PATH = fixtures.agentSlow;
		delete process.env.SANDBOX_AGENT_MAX_TURN_MS; // default ceiling, won't fire

		for (const bad of ["abc", ""]) {
			process.env.SANDBOX_AGENT_IDLE_TIMEOUT_MS = bad;
			const events: AgentEvent[] = [];
			// With the default 120s window the ~2.5s fixture finishes cleanly;
			// an immediate (NaN/0) fire would kill it before `completed`.
			const result = await spawnAgent(makeInput((e) => events.push(e)));
			expect(result.exitCode).toBe(0);
			expect(events.find((e) => e.type === "failed")).toBeUndefined();
		}
	}, 20_000);
});
