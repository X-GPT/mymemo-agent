import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import {
	claimNextRunTx,
	createQueuedRunTx,
	RunFenceError,
	type RunRecord,
	transitionRunTerminalTx,
} from "@mymemo/agent-db/run-store";
import {
	conversationRuntime,
	conversations,
	orphanSandboxes,
	runEvents,
	runs,
} from "@mymemo/agent-db/schema";
import { createTestDatabase, type TestDb } from "@mymemo/agent-db/testing";
import { eq } from "drizzle-orm";
import type { ArtifactPublisher } from "../artifacts/artifact-publication";
import {
	DEFAULT_BASH_TOOL_LIMITS,
	type SandboxCommandClient,
} from "../bash-tool/bash-tool";
import type { ScopedDocumentQueryClient } from "../documents/client";
import { DocumentScopeError } from "../documents/errors";
import type {
	ProvisionForRunInput,
	SandboxProvisioner,
} from "../e2b/sandbox-provisioner";
import type { SandboxFileClient } from "../file-tools/file-tools";
import type { WorkerLogger } from "../logger";
import type { SupervisedQuery } from "./agent-stream";
import { EXECUTOR_ALLOWED_TOOLS, EXECUTOR_SERVER_NAME } from "./run-tools";
import { conversationWorkingDirectory } from "./session-store";
import {
	createStartRunQuery,
	MYMEMO_SYSTEM_PROMPT,
	type StartRunQueryDeps,
} from "./start-run-query";

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

const WORKER_ID = "worker-1";
const USER_ID = "user-1";

let tdb: TestDb;

// One PGlite instance for the whole file (spin-up is the slow part); each test
// starts from empty tables via delete, keeping isolation without the cost.
beforeAll(async () => {
	tdb = await createTestDatabase();
});

afterAll(async () => {
	await tdb.close();
});

beforeEach(async () => {
	await tdb.db.delete(runs); // cascades run_events
	await tdb.db.delete(conversationRuntime);
	await tdb.db.delete(orphanSandboxes);
	await tdb.db.delete(conversations);
});

/** Queue a run with its run_started event (as chat-api admission writes it)
 * and claim it for WORKER_ID, so the orchestration acts under live ownership. */
async function createClaimedRun(input: {
	runId: string;
	conversationId: string;
	message?: string;
	scope?: string;
	collectionId?: string | null;
	summaryId?: string | null;
}): Promise<RunRecord> {
	await tdb.db
		.insert(conversations)
		.values({
			userId: USER_ID,
			conversationId: input.conversationId,
			scope: "general",
		})
		.onConflictDoNothing();
	await createQueuedRunTx(tdb.db, {
		runId: input.runId,
		userId: USER_ID,
		conversationId: input.conversationId,
	});
	await tdb.db
		.update(runs)
		.set({ nextEventSeq: 2 })
		.where(eq(runs.runId, input.runId));
	await tdb.db.insert(runEvents).values({
		runId: input.runId,
		seq: 1,
		type: "run_started",
		payload: {
			userId: USER_ID,
			conversationId: input.conversationId,
			runId: input.runId,
			messageId: `${input.runId}-message`,
			message: input.message ?? "hello agent",
			scope: input.scope ?? "general",
			collectionId: input.collectionId ?? null,
			summaryId: input.summaryId ?? null,
		},
	});
	const claimed = await claimNextRunTx(tdb.db, { workerId: WORKER_ID });
	if (claimed?.runId !== input.runId) {
		throw new Error(
			`test setup claimed ${claimed?.runId}, wanted ${input.runId}`,
		);
	}
	return claimed;
}

async function insertRuntimeRow(input: {
	conversationId: string;
	sandboxId: string | null;
	sandboxTainted?: boolean;
	agentSessionId?: string | null;
}) {
	await tdb.db.insert(conversationRuntime).values({
		userId: USER_ID,
		conversationId: input.conversationId,
		sandboxId: input.sandboxId,
		sandboxTainted: input.sandboxTainted ?? false,
		agentSessionId: input.agentSessionId ?? null,
	});
}

async function readRuntimeRow(conversationId: string) {
	const [row] = await tdb.db
		.select()
		.from(conversationRuntime)
		.where(eq(conversationRuntime.conversationId, conversationId));
	return row;
}

async function readOrphans() {
	return await tdb.db.select().from(orphanSandboxes);
}

/** Poll until `predicate` holds, failing the test after `timeoutMs`. */
async function until(
	predicate: () => boolean,
	timeoutMs = 2_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("condition never held");
		await Bun.sleep(5);
	}
}

async function consume(query: SupervisedQuery): Promise<void> {
	for await (const _ of query) {
		// drain
	}
}

/** A query whose stream ends immediately, recording interrupts. */
function immediateQuery() {
	const q = {
		interrupts: 0,
		async interrupt() {
			q.interrupts++;
		},
		async *[Symbol.asyncIterator]() {},
	};
	return q;
}

/** A query whose stream stays open until the test releases it. */
function gatedQuery() {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const q = {
		interrupts: 0,
		release: () => release(),
		async interrupt() {
			q.interrupts++;
		},
		// biome-ignore lint/correctness/useYield: the fixture models a silent, still-running SDK stream.
		async *[Symbol.asyncIterator]() {
			await gate;
		},
	};
	return q;
}

/** A query that ends CLEANLY once the built options' abort controller fires —
 * the worst-case SDK stream that swallows the abort instead of throwing. */
function abortEndingQuery(getSignal: () => AbortSignal | undefined) {
	return {
		async interrupt() {},
		async *[Symbol.asyncIterator]() {
			const signal = getSignal();
			if (!signal) throw new Error("options were never captured");
			if (signal.aborted) return;
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true });
			});
		},
	};
}

interface FakeProvisionConfig {
	sandboxId: string;
	isNew: boolean;
	renewError?: Error;
	/** Runs inside provisionForRun — lets a test sabotage run ownership between
	 * the runtime-row ensure and the fenced pointer update. */
	onProvision?: (input: ProvisionForRunInput) => Promise<void>;
}

function fakeProvisioner(config: FakeProvisionConfig) {
	const calls: ProvisionForRunInput[] = [];
	const handle = {
		sandboxId: config.sandboxId,
		isNew: config.isNew,
		workspaceRoot: "/home/user",
		artifactWorkspace: {} as never,
		commandClient: {} as SandboxCommandClient,
		fileClient: {} as SandboxFileClient,
		renews: 0,
		disposed: false,
		async renew() {
			if (config.renewError) throw config.renewError;
			handle.renews++;
		},
		dispose() {
			handle.disposed = true;
		},
	};
	const provisioner: SandboxProvisioner = {
		async provisionForRun(input) {
			calls.push(input);
			await config.onProvision?.(input);
			return handle;
		},
	};
	return { provisioner, calls, handle };
}

function buildHarness(
	opts: {
		provision?: Partial<FakeProvisionConfig>;
		killError?: Error;
		sandboxIdleMs?: number;
		artifactPublisher?: ArtifactPublisher;
	} = {},
) {
	const { provisioner, calls, handle } = fakeProvisioner({
		sandboxId: "sb-new",
		isNew: true,
		...opts.provision,
	});
	const killed: string[] = [];
	const captured: { prompt?: unknown; options?: Options } = {};
	const preparedWorkingDirectories: string[] = [];
	const startupOrder: string[] = [];
	const createdClaudeConfigDirs: string[] = [];
	const disposedClaudeConfigDirs: string[] = [];
	let underlying: SupervisedQuery = immediateQuery();
	const deps: StartRunQueryDeps = {
		db: tdb.db,
		workerId: WORKER_ID,
		provisioner,
		janitor: {
			async killSandbox(sandboxId) {
				killed.push(sandboxId);
				if (opts.killError) throw opts.killError;
			},
		},
		documentClient: {} as ScopedDocumentQueryClient,
		modelClient: {
			env: {
				ANTHROPIC_BASE_URL: "https://openrouter.test/api",
				ANTHROPIC_AUTH_TOKEN: "or-key",
				ANTHROPIC_API_KEY: "",
			},
			model: "anthropic/claude-test",
		},
		pathToClaudeCodeExecutable: "/opt/sdk/cli/claude",
		async createClaudeConfigDir() {
			const path = `/tmp/ephemeral-claude-config-${createdClaudeConfigDirs.length + 1}`;
			createdClaudeConfigDirs.push(path);
			return {
				path,
				async dispose() {
					disposedClaudeConfigDirs.push(path);
				},
			};
		},
		processEnv: {
			PATH: "/usr/bin",
			HOME: "/home/worker",
			// Ambient value the ephemeral dir must override (spike s2).
			CLAUDE_CONFIG_DIR: "/home/worker/.claude",
		},
		sandboxIdleMs: opts.sandboxIdleMs ?? 300_000,
		fileLimits: {
			readMaxBytes: 1024,
			readMaxLines: 100,
			grepMaxResults: 10,
			globMaxResults: 10,
			commandMaxOutputBytes: 1024,
			commandTimeoutMs: 1_000,
		},
		bashLimits: DEFAULT_BASH_TOOL_LIMITS,
		documentSearchMaxResults: 8,
		documentListMaxResults: 20,
		documentLoad: {
			maxDocuments: 10,
			perDocumentMaxBytes: 1024,
			perCallMaxBytes: 4096,
		},
		artifactPublisher: opts.artifactPublisher ?? {
			async begin() {
				startupOrder.push("artifact-baseline");
				return {
					async publish() {
						startupOrder.push("artifact-publish");
						return null;
					},
				};
			},
		},
		async ensureWorkingDirectory(path) {
			preparedWorkingDirectories.push(path);
			startupOrder.push("working-directory");
		},
		query: (params) => {
			startupOrder.push("query");
			captured.prompt = params.prompt;
			captured.options = params.options;
			return underlying;
		},
		logger: silentLogger,
	};
	return {
		startRunQuery: createStartRunQuery(deps),
		calls,
		handle,
		killed,
		captured,
		preparedWorkingDirectories,
		startupOrder,
		createdClaudeConfigDirs,
		disposedClaudeConfigDirs,
		setQuery(query: SupervisedQuery) {
			underlying = query;
		},
	};
}

function freshSignal(): AbortSignal {
	return new AbortController().signal;
}

describe("createStartRunQuery — query configuration (ADR-0006)", () => {
	it("passes the run_started user message as a plain-string prompt", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
			message: "summarize my notes",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.captured.prompt).toBe("summarize my notes");
		expect(typeof h.captured.prompt).toBe("string");
	});

	it("builds the fail-closed query options", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		const options = h.captured.options;
		expect(options?.includePartialMessages).toBe(true);
		expect(options?.tools).toEqual([]);
		expect(options?.settingSources).toEqual([]);
		expect(options?.permissionMode).toBe("dontAsk");
		expect(options?.allowedTools?.slice().sort()).toEqual(
			[...EXECUTOR_ALLOWED_TOOLS].sort(),
		);
		expect(options?.systemPrompt).toBe(MYMEMO_SYSTEM_PROMPT);
		expect(typeof options?.systemPrompt).toBe("string");
		expect(options?.model).toBe("anthropic/claude-test");
		expect(options?.pathToClaudeCodeExecutable).toBe("/opt/sdk/cli/claude");
		expect(options?.abortController).toBeInstanceOf(AbortController);
	});

	it("teaches the model to use inventory separately from passage search and loading", () => {
		expect(MYMEMO_SYSTEM_PROMPT).toContain("ListDocuments");
		expect(MYMEMO_SYSTEM_PROMPT).toContain("count");
		expect(MYMEMO_SYSTEM_PROMPT).toContain("SearchDocuments");
		expect(MYMEMO_SYSTEM_PROMPT).toContain("LoadDocuments");
	});

	it("reserves the artifact root for user deliverables", () => {
		// The prompt interpolates ARTIFACT_ROOT; the literal here is deliberate so
		// moving the artifact root is a conscious client-contract change.
		expect(MYMEMO_SYSTEM_PROMPT).toContain("/home/user/artifacts/");
		expect(MYMEMO_SYSTEM_PROMPT).toMatch(/a note/i);
		expect(MYMEMO_SYSTEM_PROMPT).toMatch(/downloadable/i);
	});

	it("spreads the model-client env over the process env plus the ephemeral config dir", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		const env = h.captured.options?.env;
		// The subprocess env is replaced wholesale (spike s2), so the worker's
		// own env must ride along...
		expect(env?.PATH).toBe("/usr/bin");
		expect(env?.HOME).toBe("/home/worker");
		// ...under the model-client vars...
		expect(env?.ANTHROPIC_BASE_URL).toBe("https://openrouter.test/api");
		expect(env?.ANTHROPIC_AUTH_TOKEN).toBe("or-key");
		expect(env?.ANTHROPIC_API_KEY).toBe("");
		// ...and the ephemeral config dir must win over any ambient one.
		expect(env?.CLAUDE_CONFIG_DIR).toBe("/tmp/ephemeral-claude-config-1");
	});

	it("uses and disposes a fresh Claude config directory for every query", async () => {
		const h = buildHarness();
		const firstRun = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});
		await consume(await h.startRunQuery(firstRun, freshSignal()));

		const secondRun = await createClaimedRun({
			runId: "run-2",
			conversationId: "conv-2",
		});
		await consume(await h.startRunQuery(secondRun, freshSignal()));

		expect(h.createdClaudeConfigDirs).toEqual([
			"/tmp/ephemeral-claude-config-1",
			"/tmp/ephemeral-claude-config-2",
		]);
		expect(h.disposedClaudeConfigDirs).toEqual(h.createdClaudeConfigDirs);
	});

	it("exposes the run's executor tools as the in-process MCP server", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		const servers = h.captured.options?.mcpServers;
		expect(Object.keys(servers ?? {})).toEqual([EXECUTOR_SERVER_NAME]);
	});

	it("wires the session store and conversation-stable cwd, with no resume on a first turn", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.captured.options?.sessionStore).toBeDefined();
		expect(h.captured.options?.cwd).toBe(
			conversationWorkingDirectory("conv-1"),
		);
		expect(h.captured.options?.resume).toBeUndefined();
	});

	it("creates the conversation working directory before starting the query", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.preparedWorkingDirectories).toEqual([
			conversationWorkingDirectory("conv-1"),
		]);
		expect(h.startupOrder).toEqual([
			"working-directory",
			"artifact-baseline",
			"query",
		]);
	});

	it("captures the artifact baseline before the query and publishes before settling", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await consume(await h.startRunQuery(run, freshSignal()));

		expect(h.startupOrder).toEqual([
			"working-directory",
			"artifact-baseline",
			"query",
			"artifact-publish",
		]);
		expect(h.handle.disposed).toBe(true);
	});

	it("resumes the conversation's stored agent session", async () => {
		await insertRuntimeRow({
			conversationId: "conv-1",
			sandboxId: "sb-old",
			agentSessionId: "sess-42",
		});
		const h = buildHarness({
			provision: { sandboxId: "sb-old", isNew: false },
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.captured.options?.resume).toBe("sess-42");
	});

	it("fails closed on an invalid frozen scope before any provisioning", async () => {
		const h = buildHarness();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
			scope: "collection",
			collectionId: null,
		});

		await expect(h.startRunQuery(run, freshSignal())).rejects.toBeInstanceOf(
			DocumentScopeError,
		);
		expect(h.calls).toHaveLength(0);
		expect(h.captured.options).toBeUndefined();
	});
});

describe("createStartRunQuery — fenced provisioning", () => {
	it("hands the existing pointer and taint state to the provisioner and keeps it on connect", async () => {
		await insertRuntimeRow({ conversationId: "conv-1", sandboxId: "sb-old" });
		const h = buildHarness({
			provision: { sandboxId: "sb-old", isNew: false },
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.calls).toEqual([
			{
				userId: USER_ID,
				conversationId: "conv-1",
				sandboxId: "sb-old",
				sandboxTainted: false,
			},
		]);
		expect((await readRuntimeRow("conv-1"))?.sandboxId).toBe("sb-old");
		expect(await readOrphans()).toEqual([]);
	});

	it("creates the runtime row when absent and repoints to the new sandbox", async () => {
		const h = buildHarness({ provision: { sandboxId: "sb-new", isNew: true } });
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.calls).toEqual([
			{
				userId: USER_ID,
				conversationId: "conv-1",
				sandboxId: null,
				sandboxTainted: false,
			},
		]);
		const row = await readRuntimeRow("conv-1");
		expect(row?.sandboxId).toBe("sb-new");
		expect(row?.sandboxTainted).toBe(false);
		// Nothing was replaced, so nothing joins the orphan ledger.
		expect(await readOrphans()).toEqual([]);
	});

	it("is idempotent across turns: the second turn reconnects to the pointer the first wrote", async () => {
		const first = buildHarness({
			provision: { sandboxId: "sb-1", isNew: true },
		});
		const run1 = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});
		await first.startRunQuery(run1, freshSignal());
		await transitionRunTerminalTx(tdb.db, {
			runId: "run-1",
			workerId: WORKER_ID,
			status: "done",
		});

		const second = buildHarness({
			provision: { sandboxId: "sb-1", isNew: false },
		});
		const run2 = await createClaimedRun({
			runId: "run-2",
			conversationId: "conv-1",
		});
		await second.startRunQuery(run2, freshSignal());

		expect(second.calls[0]?.sandboxId).toBe("sb-1");
		expect((await readRuntimeRow("conv-1"))?.sandboxId).toBe("sb-1");
	});

	it("replaces a tainted pointer with a fresh sandbox and orphan-records the old one", async () => {
		await insertRuntimeRow({
			conversationId: "conv-1",
			sandboxId: "sb-old",
			sandboxTainted: true,
		});
		const h = buildHarness({ provision: { sandboxId: "sb-new", isNew: true } });
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect(h.calls[0]?.sandboxTainted).toBe(true);
		const row = await readRuntimeRow("conv-1");
		expect(row?.sandboxId).toBe("sb-new");
		expect(row?.sandboxTainted).toBe(false);
		const orphans = await readOrphans();
		expect(orphans).toHaveLength(1);
		expect(orphans[0]).toMatchObject({
			sandboxId: "sb-old",
			userId: USER_ID,
			conversationId: "conv-1",
			runId: "run-1",
			createdByWorkerId: WORKER_ID,
		});
		expect(orphans[0]?.reason).toMatch(/tainted/);
	});

	it("orphan-records an unreachable prior sandbox on every pointer replace", async () => {
		await insertRuntimeRow({ conversationId: "conv-1", sandboxId: "sb-old" });
		// Untainted pointer, yet the provisioner created fresh: connect failed.
		const h = buildHarness({ provision: { sandboxId: "sb-new", isNew: true } });
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await h.startRunQuery(run, freshSignal());

		expect((await readRuntimeRow("conv-1"))?.sandboxId).toBe("sb-new");
		const orphans = await readOrphans();
		expect(orphans.map((o) => o.sandboxId)).toEqual(["sb-old"]);
		expect(orphans[0]?.reason).toMatch(/unreachable/);
	});

	it("kills the new sandbox and abandons the run when the fenced repoint rejects", async () => {
		const h = buildHarness({
			provision: {
				sandboxId: "sb-new",
				isNew: true,
				// Steal ownership between the runtime-row ensure and the repoint.
				onProvision: async () => {
					await tdb.db
						.update(runs)
						.set({ lockedBy: "other-worker" })
						.where(eq(runs.runId, "run-1"));
				},
			},
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await expect(h.startRunQuery(run, freshSignal())).rejects.toBeInstanceOf(
			RunFenceError,
		);

		expect(h.killed).toEqual(["sb-new"]);
		expect(h.handle.disposed).toBe(true);
		// The kill succeeded, so the sandbox needs no ledger entry; the pointer
		// never moved and no query was started.
		expect(await readOrphans()).toEqual([]);
		expect((await readRuntimeRow("conv-1"))?.sandboxId).toBeNull();
		expect(h.captured.options).toBeUndefined();
	});

	it("orphan-records the new sandbox when the post-fence kill also fails", async () => {
		const h = buildHarness({
			provision: {
				sandboxId: "sb-new",
				isNew: true,
				onProvision: async () => {
					await tdb.db
						.update(runs)
						.set({ lockedBy: "other-worker" })
						.where(eq(runs.runId, "run-1"));
				},
			},
			killError: new Error("e2b unreachable"),
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await expect(h.startRunQuery(run, freshSignal())).rejects.toBeInstanceOf(
			RunFenceError,
		);

		const orphans = await readOrphans();
		expect(orphans).toHaveLength(1);
		expect(orphans[0]).toMatchObject({
			sandboxId: "sb-new",
			runId: "run-1",
			createdByWorkerId: WORKER_ID,
		});
	});
});

describe("createStartRunQuery — renewal and abort linkage", () => {
	it("keeps renewing the sandbox until artifact publication finishes", async () => {
		let releasePublication!: () => void;
		let announcePublication!: () => void;
		const publicationStarted = new Promise<void>((resolve) => {
			announcePublication = resolve;
		});
		const publicationGate = new Promise<void>((resolve) => {
			releasePublication = resolve;
		});
		const h = buildHarness({
			provision: { sandboxId: "sb-1", isNew: true },
			sandboxIdleMs: 20,
			artifactPublisher: {
				async begin() {
					return {
						async publish() {
							announcePublication();
							await publicationGate;
							return null;
						},
					};
				},
			},
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		const consumed = consume(await h.startRunQuery(run, freshSignal()));
		await publicationStarted;
		await until(() => h.handle.renews >= 2);
		expect(h.handle.disposed).toBe(false);

		releasePublication();
		await consumed;
		expect(h.handle.disposed).toBe(true);
	});

	it("aborts artifact publication when sandbox renewal fails", async () => {
		let publishSignal: AbortSignal | undefined;
		const h = buildHarness({
			provision: {
				sandboxId: "sb-1",
				isNew: true,
				renewError: new Error("sandbox gone"),
			},
			sandboxIdleMs: 10,
			artifactPublisher: {
				async begin({ signal }) {
					publishSignal = signal;
					return {
						async publish() {
							return await new Promise<never>((_resolve, reject) => {
								if (signal.aborted) return reject(new Error("aborted"));
								signal.addEventListener(
									"abort",
									() => reject(new Error("aborted")),
									{ once: true },
								);
							});
						},
					};
				},
			},
		});
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		await expect(
			consume(await h.startRunQuery(run, freshSignal())),
		).rejects.toThrow(/renewal/);
		expect(publishSignal?.aborted).toBe(true);
		expect(h.handle.disposed).toBe(true);
	});

	it("renews the sandbox while the query runs and stops once the stream ends", async () => {
		const h = buildHarness({
			provision: { sandboxId: "sb-1", isNew: true },
			sandboxIdleMs: 20, // renew every ~10ms
		});
		const gated = gatedQuery();
		h.setQuery(gated);
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		const query = await h.startRunQuery(run, freshSignal());
		const consumed = consume(query);
		await until(() => h.handle.renews >= 2);
		gated.release();
		await consumed;

		expect(h.handle.disposed).toBe(true);
		const renewsAtEnd = h.handle.renews;
		await Bun.sleep(50);
		expect(h.handle.renews).toBe(renewsAtEnd);
	});

	it("renewal failure aborts the linked controller and the turn ends in error, never done", async () => {
		const h = buildHarness({
			provision: {
				sandboxId: "sb-1",
				isNew: true,
				renewError: new Error("sandbox gone"),
			},
			sandboxIdleMs: 10,
		});
		// Worst case: the aborted SDK stream ends cleanly instead of throwing.
		h.setQuery(
			abortEndingQuery(() => h.captured.options?.abortController?.signal),
		);
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		const query = await h.startRunQuery(run, freshSignal());

		await expect(consume(query)).rejects.toThrow(/renewal/);
		expect(h.captured.options?.abortController?.signal.aborted).toBe(true);
		expect(h.handle.disposed).toBe(true);
	});

	it("links the run signal to the SDK abort controller and passes interrupt through", async () => {
		const h = buildHarness({ provision: { sandboxId: "sb-1", isNew: true } });
		const gated = gatedQuery();
		h.setQuery(gated);
		const controller = new AbortController();
		const run = await createClaimedRun({
			runId: "run-1",
			conversationId: "conv-1",
		});

		const query = await h.startRunQuery(run, controller.signal);
		const consumed = consume(query);

		controller.abort();
		expect(h.captured.options?.abortController?.signal.aborted).toBe(true);

		await query.interrupt();
		expect(gated.interrupts).toBe(1);

		gated.release();
		await consumed;
		expect(h.handle.disposed).toBe(true);
	});
});
