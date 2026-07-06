import { describe, expect, it } from "bun:test";
import type { RunBinding } from "../sandbox-env";
import {
	type BashToolContext,
	type CommandAuditEvent,
	type ManagedCommandSpec,
	type RawCommandOutcome,
	runBashTool,
	type SandboxCommandClient,
	type SandboxCommandSession,
} from "./bash-tool";

const BINDING: RunBinding = {
	userId: "user-1",
	conversationId: "conv-1",
	runId: "run-1",
	sandboxId: "sbx-1",
};

const OK_OUTCOME: RawCommandOutcome = {
	exitCode: 0,
	stdout: "hello\n",
	stderr: "",
	stdoutTruncated: false,
	stderrTruncated: false,
	timedOut: false,
};

interface SessionScript {
	/** How `outcome` resolves. `on-kill` resolves only once `kill()` runs. */
	resolve?: "immediate" | "on-kill";
	result?: RawCommandOutcome;
	/** Reject `outcome` with this error instead of resolving. */
	outcomeError?: Error;
	survivors?: number;
	reapError?: Error;
}

class FakeSession implements SandboxCommandSession {
	killed = 0;
	reaped = 0;
	readonly outcome: Promise<RawCommandOutcome>;
	private settle!: (outcome: RawCommandOutcome) => void;
	private reject!: (error: Error) => void;

	constructor(private readonly script: SessionScript) {
		this.outcome = new Promise((resolve, reject) => {
			this.settle = resolve;
			this.reject = reject;
		});
		if (script.outcomeError) {
			this.reject(script.outcomeError);
		} else if ((script.resolve ?? "immediate") === "immediate") {
			this.settle(script.result ?? OK_OUTCOME);
		}
	}

	async kill(): Promise<void> {
		this.killed++;
		if (this.script.resolve === "on-kill") {
			this.settle(this.script.result ?? OK_OUTCOME);
		}
	}

	async reap(): Promise<{ survivors: number }> {
		this.reaped++;
		if (this.script.reapError) throw this.script.reapError;
		return { survivors: this.script.survivors ?? 0 };
	}
}

class FakeCommandClient implements SandboxCommandClient {
	readonly starts: ManagedCommandSpec[] = [];
	readonly sessions: FakeSession[] = [];

	constructor(private readonly script: SessionScript = {}) {}

	start(spec: ManagedCommandSpec): SandboxCommandSession {
		this.starts.push(spec);
		const session = new FakeSession(this.script);
		this.sessions.push(session);
		return session;
	}
}

function makeContext(
	overrides: Partial<BashToolContext> & { client: SandboxCommandClient },
): {
	context: BashToolContext;
	audits: CommandAuditEvent[];
	taints: string[];
	dirtyCount: () => number;
} {
	const audits: CommandAuditEvent[] = [];
	const taints: string[] = [];
	let dirty = 0;
	const context: BashToolContext = {
		client: overrides.client,
		workspaceRoot: overrides.workspaceRoot ?? "/workspace",
		binding: overrides.binding ?? BINDING,
		limits: overrides.limits ?? {
			systemMaxTimeoutMs: 120_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 65_536,
		},
		signal: overrides.signal ?? new AbortController().signal,
		markWorkspaceDirty: async () => {
			dirty++;
		},
		markSandboxTainted: async (reason: string) => {
			taints.push(reason);
		},
		recordCommandAudit: async (event: CommandAuditEvent) => {
			audits.push(event);
		},
	};
	return { context, audits, taints, dirtyCount: () => dirty };
}

function parseResult(result: { content: { text: string }[] }) {
	const [first] = result.content;
	if (!first) throw new Error("missing tool content");
	return JSON.parse(first.text);
}

describe("runBashTool", () => {
	it("runs a command and returns bounded exit/stdout/stderr with outcome", async () => {
		const client = new FakeCommandClient({ result: OK_OUTCOME });
		const { context, dirtyCount } = makeContext({ client });

		const result = await runBashTool({ command: "echo hello" }, context);

		expect(result.isError).toBeUndefined();
		expect(parseResult(result)).toEqual({
			exitCode: 0,
			stdout: "hello\n",
			stderr: "",
			stdoutTruncated: false,
			stderrTruncated: false,
			outcome: "completed",
		});
		expect(client.starts).toHaveLength(1);
		expect(client.sessions[0]?.reaped).toBe(1);
		expect(dirtyCount()).toBe(1);
	});

	it("clamps the requested timeout to the system maximum", async () => {
		const client = new FakeCommandClient({ result: OK_OUTCOME });
		const { context } = makeContext({
			client,
			limits: {
				systemMaxTimeoutMs: 5_000,
				maxStdoutBytes: 65_536,
				maxStderrBytes: 65_536,
			},
		});

		await runBashTool({ command: "sleep 1", timeoutMs: 10 * 60_000 }, context);

		expect(client.starts[0]?.timeoutMs).toBe(5_000);
	});

	it("times out a hung command by killing its process group", async () => {
		const client = new FakeCommandClient({
			resolve: "on-kill",
			result: { ...OK_OUTCOME, exitCode: null, timedOut: false },
		});
		const { context, audits } = makeContext({
			client,
			limits: {
				systemMaxTimeoutMs: 15,
				maxStdoutBytes: 65_536,
				maxStderrBytes: 65_536,
			},
		});

		const result = await runBashTool({ command: "sleep 300" }, context);

		expect(client.sessions[0]?.killed).toBe(1);
		expect(parseResult(result).outcome).toBe("timeout");
		expect(audits.at(-1)?.outcome).toBe("timeout");
	});

	it("bounds oversized output and flags truncation", async () => {
		const client = new FakeCommandClient({
			result: {
				...OK_OUTCOME,
				stdout: "x".repeat(100),
				stdoutTruncated: false,
			},
		});
		const { context } = makeContext({
			client,
			limits: {
				systemMaxTimeoutMs: 120_000,
				maxStdoutBytes: 10,
				maxStderrBytes: 10,
			},
		});

		const result = await runBashTool({ command: "yes" }, context);

		const parsed = parseResult(result);
		expect(parsed.stdout).toBe("xxxxxxxxxx");
		expect(parsed.stdoutTruncated).toBe(true);
	});

	it("rejects obvious detached forms before any sandbox call", async () => {
		const client = new FakeCommandClient();
		const { context } = makeContext({ client });

		for (const command of [
			"sleep 300 &",
			"nohup long-task",
			"my-cmd | disown",
			"setsid daemon",
		]) {
			const result = await runBashTool({ command }, context);
			expect(result.isError).toBe(true);
			expect(result.content[0]?.text).toContain("foreground");
		}
		expect(client.starts).toEqual([]);
	});

	it("allows in-command backgrounding (the wrapper reaps it)", async () => {
		const client = new FakeCommandClient({ result: OK_OUTCOME });
		const { context } = makeContext({ client });

		// `a && b` and `2>&1` contain `&` but are not detached forms.
		const result = await runBashTool(
			{ command: "make build && ./run 2>&1" },
			context,
		);

		expect(result.isError).toBeUndefined();
		expect(client.starts).toHaveLength(1);
	});

	it("invokes the cancel path when the run signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const client = new FakeCommandClient({
			resolve: "on-kill",
			result: { ...OK_OUTCOME, exitCode: null },
		});
		const { context, audits } = makeContext({
			client,
			signal: controller.signal,
		});

		const result = await runBashTool({ command: "sleep 300" }, context);

		expect(client.sessions[0]?.killed).toBe(1);
		expect(parseResult(result).outcome).toBe("canceled");
		expect(audits.at(-1)?.outcome).toBe("canceled");
	});

	it("invokes the cancel path when the signal aborts mid-command", async () => {
		const controller = new AbortController();
		const client = new FakeCommandClient({
			resolve: "on-kill",
			result: { ...OK_OUTCOME, exitCode: null },
		});
		const { context } = makeContext({ client, signal: controller.signal });

		const running = runBashTool({ command: "sleep 300" }, context);
		await Promise.resolve();
		controller.abort();
		const result = await running;

		expect(client.sessions[0]?.killed).toBe(1);
		expect(parseResult(result).outcome).toBe("canceled");
	});

	it("taints the sandbox and refuses a clean result when survivors remain", async () => {
		const client = new FakeCommandClient({ result: OK_OUTCOME, survivors: 2 });
		const { context, taints, audits } = makeContext({ client });

		const result = await runBashTool({ command: "spawn-daemon" }, context);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("unhealthy");
		expect(taints).toHaveLength(1);
		expect(taints[0]).toContain("cleanup failed");
		expect(audits.at(-1)?.cleanupOk).toBe(false);
	});

	it("taints the sandbox when the reap itself fails", async () => {
		const client = new FakeCommandClient({
			result: OK_OUTCOME,
			reapError: new Error("sandbox unreachable"),
		});
		const { context, taints } = makeContext({ client });

		const result = await runBashTool({ command: "echo hi" }, context);

		expect(result.isError).toBe(true);
		expect(taints).toHaveLength(1);
	});

	it("binds every command's audit events to the full run binding", async () => {
		const client = new FakeCommandClient({ result: OK_OUTCOME });
		const { context, audits } = makeContext({ client });

		await runBashTool({ command: "ls", cwd: "src" }, context);

		expect(audits.map((event) => event.phase)).toEqual(["started", "finished"]);
		for (const event of audits) {
			expect(event.binding).toEqual(BINDING);
			expect(event.command).toBe("ls");
			expect(event.cwd).toBe("src");
		}
		// Both events describe the same command instance.
		expect(audits[0]?.commandId).toBe(audits[1]?.commandId ?? "");
	});

	it("rejects a cwd outside the workspace before any sandbox call", async () => {
		const client = new FakeCommandClient();
		const { context } = makeContext({ client });

		const result = await runBashTool({ command: "ls", cwd: "../etc" }, context);

		expect(result.isError).toBe(true);
		expect(client.starts).toEqual([]);
	});

	it("rejects an empty command", async () => {
		const client = new FakeCommandClient();
		const { context } = makeContext({ client });

		const result = await runBashTool({ command: "   " }, context);

		expect(result.isError).toBe(true);
		expect(client.starts).toEqual([]);
	});

	it("surfaces a client failure as a bounded error but still reaps", async () => {
		const client = new FakeCommandClient({
			outcomeError: new Error("sandbox died"),
		});
		const { context } = makeContext({ client });

		const result = await runBashTool({ command: "echo hi" }, context);

		expect(result.isError).toBe(true);
		expect(result.content[0]?.text).toContain("Bash failed");
		expect(client.sessions[0]?.reaped).toBe(1);
	});
});
