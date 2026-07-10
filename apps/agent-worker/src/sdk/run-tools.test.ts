import { describe, expect, it } from "bun:test";
import type {
	CommandAuditEvent,
	RawCommandOutcome,
	SandboxCommandClient,
	SandboxCommandSession,
} from "../bash-tool/bash-tool";
import type { ScopedDocumentQueryClient } from "../documents/client";
import { DOCS_CACHE_DIRNAME } from "../documents/load-documents-tool";
import type { SandboxFileClient } from "../file-tools/file-tools";
import type { RunBinding } from "../sandbox-env";
import {
	buildRunTools,
	createRunMcpServer,
	EXECUTOR_ALLOWED_TOOLS,
	EXECUTOR_SERVER_NAME,
	type RunToolDeps,
} from "./run-tools";

const BINDING: RunBinding = {
	userId: "user-1",
	conversationId: "conv-1",
	runId: "run-1",
	sandboxId: "sandbox-1",
};

const WORKSPACE_ROOT = "/workspace";

function fakeFileClient(): SandboxFileClient & {
	reads: string[];
	writes: { path: string; content: string }[];
	commands: string[];
} {
	const state = {
		reads: [] as string[],
		writes: [] as { path: string; content: string }[],
		commands: [] as string[],
		async readFile(input: { path: string; maxBytes: number }) {
			state.reads.push(input.path);
			return "file body";
		},
		async writeFile(input: { path: string; content: string }) {
			state.writes.push(input);
		},
		async runCommand(input: { command: string }) {
			state.commands.push(input.command);
			return { exitCode: 0, stdout: "", stderr: "", truncated: false };
		},
	};
	return state;
}

function fakeCommandClient(): SandboxCommandClient & {
	specs: { commandId: string; command: string }[];
} {
	const specs: { commandId: string; command: string }[] = [];
	return {
		specs,
		start(spec): SandboxCommandSession {
			specs.push({ commandId: spec.commandId, command: spec.command });
			return {
				outcome: Promise.resolve({
					exitCode: 0,
					stdout: "hi\n",
					stderr: "",
					stdoutTruncated: false,
					stderrTruncated: false,
					timedOut: false,
				}),
				async kill() {},
				async reap() {
					return { survivors: 0 };
				},
			};
		},
	};
}

function fakeDocumentClient(): ScopedDocumentQueryClient & {
	searchCalls: unknown[];
	fetchCalls: unknown[];
} {
	const searchCalls: unknown[] = [];
	const fetchCalls: unknown[] = [];
	return {
		searchCalls,
		fetchCalls,
		async searchDocuments(input) {
			searchCalls.push(input);
			return { passages: [] };
		},
		async fetchDocumentInScope(input) {
			fetchCalls.push(input);
			return {
				documentId: (input as { documentId: string }).documentId,
				title: "Doc Title",
				content: "document body",
				truncated: false,
			};
		},
	};
}

function buildDeps(overrides: Partial<RunToolDeps> = {}): {
	deps: RunToolDeps;
	fileClient: ReturnType<typeof fakeFileClient>;
	commandClient: ReturnType<typeof fakeCommandClient>;
	documentClient: ReturnType<typeof fakeDocumentClient>;
	audits: CommandAuditEvent[];
	tainted: string[];
} {
	const fileClient = fakeFileClient();
	const commandClient = fakeCommandClient();
	const documentClient = fakeDocumentClient();
	const audits: CommandAuditEvent[] = [];
	const tainted: string[] = [];
	const deps: RunToolDeps = {
		binding: BINDING,
		workspaceRoot: WORKSPACE_ROOT,
		signal: new AbortController().signal,
		fileClient,
		commandClient,
		documentClient,
		documentScope: { type: "general" },
		fileLimits: {
			readMaxBytes: 65_536,
			readMaxLines: 2_000,
			grepMaxResults: 100,
			globMaxResults: 100,
			commandMaxOutputBytes: 65_536,
			commandTimeoutMs: 30_000,
		},
		bashLimits: {
			systemMaxTimeoutMs: 120_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 65_536,
		},
		documentSearchMaxResults: 8,
		documentLoad: {
			maxDocuments: 10,
			perDocumentMaxBytes: 262_144,
			perCallMaxBytes: 1_048_576,
		},
		async markSandboxTainted(reason) {
			tainted.push(reason);
		},
		async recordCommandAudit(event) {
			audits.push(event);
		},
		...overrides,
	};
	return {
		deps,
		fileClient,
		commandClient,
		documentClient,
		audits,
		tainted,
	};
}

function toolsByName(deps: RunToolDeps) {
	return Object.fromEntries(buildRunTools(deps).map((t) => [t.name, t]));
}

describe("buildRunTools — surface", () => {
	it("exposes the file, Bash, and document executor tools", () => {
		const names = buildRunTools(buildDeps().deps)
			.map((t) => t.name)
			.sort();
		expect(names).toEqual([
			"Bash",
			"Edit",
			"Glob",
			"Grep",
			"LoadDocuments",
			"Read",
			"SearchDocuments",
			"Write",
		]);
	});

	// The fail-closed allowlist (ADR-0006) is built from these exports; if a
	// tool is added or renamed without updating them, the query would silently
	// deny it — so the constants are pinned to what buildRunTools actually builds.
	it("EXECUTOR_ALLOWED_TOOLS names exactly the built tools, MCP-qualified", () => {
		const built = buildRunTools(buildDeps().deps).map(
			(t) => `mcp__${EXECUTOR_SERVER_NAME}__${t.name}`,
		);
		expect([...EXECUTOR_ALLOWED_TOOLS].sort()).toEqual([...built].sort());
	});
});

describe("buildRunTools — run binding", () => {
	it("binds Bash to the full run binding on every command audit event", async () => {
		const ctx = buildDeps();
		await toolsByName(ctx.deps).Bash?.handler({ command: "echo hi" }, {});

		expect(ctx.commandClient.specs).toHaveLength(1);
		expect(ctx.audits.length).toBeGreaterThanOrEqual(2);
		for (const event of ctx.audits) {
			expect(event.binding).toEqual(BINDING);
		}
	});

	it("binds SearchDocuments to the document access binding and frozen scope", async () => {
		const ctx = buildDeps();
		await toolsByName(ctx.deps).SearchDocuments?.handler({ query: "q" }, {});

		expect(ctx.documentClient.searchCalls).toHaveLength(1);
		expect(ctx.documentClient.searchCalls[0]).toMatchObject({
			binding: {
				userId: BINDING.userId,
				conversationId: BINDING.conversationId,
				runId: BINDING.runId,
			},
			scope: { type: "general" },
		});
	});

	it("binds LoadDocuments to the document access binding and caches under the docs dir", async () => {
		const ctx = buildDeps();
		await toolsByName(ctx.deps).LoadDocuments?.handler(
			{ documentIds: ["doc-1"] },
			{},
		);

		expect(ctx.documentClient.fetchCalls).toHaveLength(1);
		expect(ctx.documentClient.fetchCalls[0]).toMatchObject({
			binding: {
				userId: BINDING.userId,
				conversationId: BINDING.conversationId,
				runId: BINDING.runId,
			},
		});
		expect(ctx.fileClient.writes).toHaveLength(1);
		expect(ctx.fileClient.writes[0]?.path).toBe(
			`${WORKSPACE_ROOT}/${DOCS_CACHE_DIRNAME}/doc-1.md`,
		);
	});
});

describe("buildRunTools — file tools operate in the run workspace", () => {
	it("routes Read through the run's sandbox file client, workspace-rooted", async () => {
		const ctx = buildDeps();
		const result = await toolsByName(ctx.deps).Read?.handler(
			{ path: "notes.txt" },
			{},
		);

		expect(result?.isError).toBeUndefined();
		expect(ctx.fileClient.reads).toEqual([`${WORKSPACE_ROOT}/notes.txt`]);
	});

	it("routes Write through the run's sandbox file client", async () => {
		const ctx = buildDeps();
		await toolsByName(ctx.deps).Write?.handler(
			{ path: "notes.txt", content: "hello" },
			{},
		);

		expect(ctx.fileClient.writes).toHaveLength(1);
	});
});

describe("buildRunTools — the run signal cancels active commands", () => {
	it("kills a running Bash command when the run signal aborts", async () => {
		const controller = new AbortController();
		let killed = false;
		let started!: () => void;
		const startedGate = new Promise<void>((r) => {
			started = r;
		});
		let resolveOutcome!: (o: RawCommandOutcome) => void;
		const commandClient: SandboxCommandClient = {
			start() {
				started();
				return {
					outcome: new Promise<RawCommandOutcome>((resolve) => {
						resolveOutcome = resolve;
					}),
					async kill() {
						killed = true;
						resolveOutcome({
							exitCode: null,
							stdout: "",
							stderr: "",
							stdoutTruncated: false,
							stderrTruncated: false,
							timedOut: false,
						});
					},
					async reap() {
						return { survivors: 0 };
					},
				};
			},
		};
		const { deps } = buildDeps({ signal: controller.signal, commandClient });

		const pending = toolsByName(deps).Bash?.handler(
			{ command: "sleep 100" },
			{},
		);
		await startedGate; // command started and the abort listener is registered
		controller.abort();
		const result = await pending;

		expect(killed).toBe(true);
		const payload = JSON.parse(
			(result?.content?.[0] as { text: string }).text,
		) as { outcome: string };
		expect(payload.outcome).toBe("canceled");
	});
});

describe("createRunMcpServer", () => {
	it("wraps the bound tools in an in-process SDK MCP server", () => {
		const server = createRunMcpServer(buildDeps().deps);
		expect(server.type).toBe("sdk");
	});
});
