import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import { loadRunStartedTx, type RunRecord } from "@mymemo/agent-db/run-store";
import {
	type ConversationRuntimeRecord,
	createConversationRuntimeTx,
	markRuntimeSandboxTaintedTx,
	type RunOwnershipRef,
	recordOrphanSandboxTx,
	updateRuntimeSandboxTx,
} from "@mymemo/agent-db/runtime-store";
import type { BashToolLimits } from "../bash-tool/bash-tool";
import type { SandboxJanitor } from "../cleanup/cleanup";
import type { ScopedDocumentQueryClient } from "../documents/client";
import { parseFrozenScope } from "../documents/scope";
import {
	type ProvisionedSandbox,
	SANDBOX_WORKSPACE_ROOT,
	type SandboxProvisioner,
} from "../e2b/sandbox-provisioner";
import type { FileToolLimits } from "../file-tools/file-tools";
import type { WorkerLogger } from "../logger";
import type { ModelClientConfig } from "../model-client";
import type { RunBinding } from "../sandbox-env";
import type { SupervisedQuery } from "./agent-stream";
import type { StartRunQuery } from "./run-processor";
import {
	createRunMcpServer,
	EXECUTOR_ALLOWED_TOOLS,
	EXECUTOR_SERVER_NAME,
	type RunToolDeps,
} from "./run-tools";
import { startSandboxRenewal } from "./sandbox-renewal";
import { buildAgentSessionQueryConfig } from "./session-store";

/**
 * The orchestration behind the {@link StartRunQuery} seam (spec Milestone 9,
 * Task 9.5): read what the user asked for from the run's durable `run_started`
 * event, provision the conversation's E2B workspace under the ownership fence
 * (connect-or-create, ADR-0007), keep it alive for the turn, and start the
 * fail-closed Claude Agent SDK query (ADR-0006). Every side effect enters
 * through an injected seam — the provisioner, the janitor, and the SDK `query`
 * function — so fence/orphan/renewal/config behavior is deterministic under
 * test with no credentials.
 */

/**
 * The static MyMemo system prompt (ADR-0006): a plain string, no `claude_code`
 * preset — the preset describes native tools the query disables and
 * Fargate-side anchors that would mislead. Static by construction (no per-run
 * interpolation) so it is cacheable across conversations.
 */
export const MYMEMO_SYSTEM_PROMPT =
	"You are MyMemo's agent. You answer the user's questions and do file-backed work on their behalf.\n\n" +
	"Your only tools are the MyMemo executor tools. Read, Write, Edit, Grep, Glob, and Bash act on the " +
	`conversation's sandboxed workspace rooted at ${SANDBOX_WORKSPACE_ROOT} — never on the machine running you. ` +
	"SearchDocuments and LoadDocuments reach the user's MyMemo knowledge base, limited to this conversation's " +
	"scope; LoadDocuments writes documents into the workspace's docs cache and returns their paths so you can " +
	"read and cite them.\n\n" +
	"Ground claims about the user's documents in what SearchDocuments and LoadDocuments return, and keep " +
	"responses concise.";

/**
 * Sandbox keep-alive renewal failed mid-turn: the workspace may have paused or
 * died while the model was still working, so the turn must end `error`, never
 * `done` — even when the aborted SDK stream ends without raising.
 */
export class SandboxRenewalError extends Error {
	override name = "SandboxRenewalError" as const;
	constructor(cause: unknown) {
		super("sandbox keep-alive renewal failed during the run", { cause });
	}
}

/**
 * The SDK `query()` call as a seam: production passes the real function (typed
 * to the structural {@link SupervisedQuery} the supervisor consumes), tests a
 * fake that captures the built options. The prompt is deliberately typed as a
 * plain string — never a held-open input stream, which `interrupt()` cannot
 * end (spike s5).
 */
export type RunQueryFn = (params: {
	prompt: string;
	options: Options;
}) => SupervisedQuery;

export interface StartRunQueryDeps {
	db: Database;
	workerId: string;
	provisioner: SandboxProvisioner;
	/** Kills a fresh sandbox the fence refused to point to (never a live one). */
	janitor: SandboxJanitor;
	documentClient: ScopedDocumentQueryClient;
	modelClient: ModelClientConfig;
	/** The boot-verified pinned glibc CLI binary (spike s3). */
	pathToClaudeCodeExecutable: string;
	/** Ephemeral dir for the CLI's local transcript copy; the Postgres session
	 * store is the durable mirror (spike s2, ADR-0005). */
	claudeConfigDir: string;
	/** The worker process env the model-client vars are spread over — the SDK
	 * query env REPLACES the subprocess env, so it must ride along (spike s2). */
	processEnv: Record<string, string | undefined>;
	/** The sandbox idle window; renewal runs at half this cadence. */
	sandboxIdleMs: number;
	fileLimits: FileToolLimits;
	bashLimits: BashToolLimits;
	documentSearchMaxResults: number;
	documentLoad: {
		maxDocuments: number;
		perDocumentMaxBytes: number;
		perCallMaxBytes: number;
	};
	query: RunQueryFn;
	logger: WorkerLogger;
}

export function createStartRunQuery(deps: StartRunQueryDeps): StartRunQuery {
	return async (run, signal) => {
		const started = await loadRunStartedTx(deps.db, { runId: run.runId });
		// Parse the frozen scope fail-closed before any side effect: a run whose
		// scope cannot be trusted must not provision or query anything.
		const documentScope = parseFrozenScope(started);
		const owner: RunOwnershipRef = {
			userId: run.userId,
			conversationId: run.conversationId,
			runId: run.runId,
			workerId: deps.workerId,
		};

		const { provisioned, runtime } = await provisionWorkspace(deps, owner);

		// One controller links every way this turn can be told to stop: the
		// supervisor's signal (cancel, ownership loss, shutdown) and a renewal
		// failure. It aborts the SDK query and kills any running Bash command.
		const controller = new AbortController();
		const abortQuery = (): void => controller.abort();
		if (signal.aborted) abortQuery();
		else signal.addEventListener("abort", abortQuery, { once: true });

		let renewalFailure: { error: unknown } | null = null;
		const renewal = startSandboxRenewal({
			renew: () => provisioned.renew(),
			intervalMs: Math.max(1, Math.floor(deps.sandboxIdleMs / 2)),
			onFailure: (error) => {
				renewalFailure = { error };
				deps.logger.error({
					message: "sandbox renewal failed; aborting the run",
					runId: run.runId,
					sandboxId: provisioned.sandboxId,
					error: toMessage(error),
				});
				controller.abort();
			},
		});
		const settle = (): void => {
			renewal.stop();
			// The paused sandbox IS the persisted workspace (ADR-0007): dispose
			// only stops keeping it awake.
			provisioned.dispose();
			signal.removeEventListener("abort", abortQuery);
		};

		try {
			const options = buildQueryOptions(deps, {
				run,
				owner,
				runtime,
				provisioned,
				documentScope,
				controller,
			});
			const underlying = deps.query({ prompt: started.message, options });
			return superviseTurn(underlying, settle, () => renewalFailure);
		} catch (error) {
			settle();
			throw error;
		}
	};
}

/**
 * Ensure the conversation's runtime row (idempotent, fenced), provision the
 * workspace connect-or-create, and persist a fresh sandbox through the fenced
 * pointer update. A fresh sandbox the fence refuses to record has escaped
 * database ownership: kill it, ledger it if the kill fails, and abandon the
 * run — the fence says recovery (or the real owner) is in charge now. Every
 * pointer replace orphan-records the prior sandbox so the janitor reclaims it.
 */
async function provisionWorkspace(
	deps: StartRunQueryDeps,
	owner: RunOwnershipRef,
): Promise<{
	provisioned: ProvisionedSandbox;
	runtime: ConversationRuntimeRecord;
}> {
	const existing = await createConversationRuntimeTx(deps.db, owner);
	const provisioned = await deps.provisioner.provisionForRun({
		userId: owner.userId,
		conversationId: owner.conversationId,
		sandboxId: existing.sandboxId,
		sandboxTainted: existing.sandboxTainted,
	});
	if (!provisioned.isNew) return { provisioned, runtime: existing };

	let runtime: ConversationRuntimeRecord;
	try {
		runtime = await updateRuntimeSandboxTx(deps.db, {
			...owner,
			sandboxId: provisioned.sandboxId,
		});
	} catch (error) {
		provisioned.dispose();
		await killOrRecordOrphan(deps, owner, provisioned.sandboxId);
		throw error;
	}
	if (existing.sandboxId !== null) {
		await recordReplacedSandbox(deps, owner, existing);
	}
	return { provisioned, runtime };
}

/** Kill a sandbox that escaped the fenced pointer; if even the kill fails,
 * record it in the (deliberately unfenced) orphan ledger for the janitor. */
async function killOrRecordOrphan(
	deps: StartRunQueryDeps,
	owner: RunOwnershipRef,
	sandboxId: string,
): Promise<void> {
	try {
		await deps.janitor.killSandbox(sandboxId);
	} catch (killError) {
		deps.logger.warn({
			message: "could not kill escaped sandbox; recording it as orphaned",
			sandboxId,
			runId: owner.runId,
			error: toMessage(killError),
		});
		try {
			await recordOrphanSandboxTx(deps.db, {
				sandboxId,
				userId: owner.userId,
				conversationId: owner.conversationId,
				runId: owner.runId,
				createdByWorkerId: owner.workerId,
				reason: "sandbox pointer update was fenced and the kill failed",
			});
		} catch (recordError) {
			deps.logger.error({
				message: "could not orphan-record escaped sandbox",
				sandboxId,
				runId: owner.runId,
				error: toMessage(recordError),
			});
		}
	}
}

/**
 * Ledger the sandbox a successful repoint just replaced. Best-effort like the
 * run loop's pointer advance: the new pointer is already durable, so a failed
 * ledger write only risks leaking the old sandbox — never the turn.
 */
async function recordReplacedSandbox(
	deps: StartRunQueryDeps,
	owner: RunOwnershipRef,
	prior: ConversationRuntimeRecord,
): Promise<void> {
	if (prior.sandboxId === null) return;
	try {
		await recordOrphanSandboxTx(deps.db, {
			sandboxId: prior.sandboxId,
			userId: owner.userId,
			conversationId: owner.conversationId,
			runId: owner.runId,
			createdByWorkerId: owner.workerId,
			reason: prior.sandboxTainted
				? "tainted sandbox replaced during provisioning"
				: "unreachable sandbox replaced during provisioning",
		});
	} catch (error) {
		deps.logger.warn({
			message: "could not orphan-record replaced sandbox",
			sandboxId: prior.sandboxId,
			runId: owner.runId,
			error: toMessage(error),
		});
	}
}

/** Assemble the fail-closed SDK query options (ADR-0006 + the s2/s3 spike
 * verdicts) for one provisioned run. */
function buildQueryOptions(
	deps: StartRunQueryDeps,
	input: {
		run: RunRecord;
		owner: RunOwnershipRef;
		runtime: ConversationRuntimeRecord;
		provisioned: ProvisionedSandbox;
		documentScope: RunToolDeps["documentScope"];
		controller: AbortController;
	},
): Options {
	const { run, owner, runtime, provisioned, documentScope, controller } = input;
	const binding: RunBinding = {
		userId: run.userId,
		conversationId: run.conversationId,
		runId: run.runId,
		sandboxId: provisioned.sandboxId,
	};
	const toolDeps: RunToolDeps = {
		binding,
		workspaceRoot: provisioned.workspaceRoot,
		signal: controller.signal,
		fileClient: provisioned.fileClient,
		commandClient: provisioned.commandClient,
		documentClient: deps.documentClient,
		documentScope,
		fileLimits: deps.fileLimits,
		bashLimits: deps.bashLimits,
		documentSearchMaxResults: deps.documentSearchMaxResults,
		documentLoad: deps.documentLoad,
		markSandboxTainted: async (reason) => {
			deps.logger.warn({
				message: "marking run sandbox tainted",
				...binding,
				reason,
			});
			await markRuntimeSandboxTaintedTx(deps.db, owner);
		},
		recordCommandAudit: async (event) => {
			deps.logger.info({ message: "bash command audit", ...event });
		},
	};
	const sessionConfig = buildAgentSessionQueryConfig({
		db: deps.db,
		conversationId: run.conversationId,
		runtime,
	});

	return {
		// Two independent guards (ADR-0006): every built-in tool is disabled, and
		// even a tool that reappeared is denied — never prompted, never executed
		// on the worker host.
		tools: [],
		settingSources: [],
		permissionMode: "dontAsk",
		allowedTools: [...EXECUTOR_ALLOWED_TOOLS],
		systemPrompt: MYMEMO_SYSTEM_PROMPT,
		model: deps.modelClient.model,
		// Options.env REPLACES the subprocess env (spike s2): worker env under
		// the model-client vars, with the ephemeral config dir winning over any
		// ambient CLAUDE_CONFIG_DIR.
		env: {
			...deps.processEnv,
			...deps.modelClient.env,
			CLAUDE_CONFIG_DIR: deps.claudeConfigDir,
		},
		pathToClaudeCodeExecutable: deps.pathToClaudeCodeExecutable,
		mcpServers: { [EXECUTOR_SERVER_NAME]: createRunMcpServer(toolDeps) },
		abortController: controller,
		sessionStore: sessionConfig.sessionStore,
		cwd: sessionConfig.cwd,
		...(sessionConfig.resume !== undefined
			? { resume: sessionConfig.resume }
			: {}),
	};
}

/**
 * Wrap the SDK query so the turn's per-run resources settle exactly when its
 * stream does (renewal stops, the sandbox is left to idle-pause), and a
 * renewal failure can never end the turn cleanly: even when the aborted SDK
 * stream ends without raising, the wrapper throws {@link SandboxRenewalError}
 * so the run terminalizes `error`, never `done`.
 */
function superviseTurn(
	underlying: SupervisedQuery,
	settle: () => void,
	renewalFailure: () => { error: unknown } | null,
): SupervisedQuery {
	return {
		interrupt: () => underlying.interrupt(),
		async *[Symbol.asyncIterator]() {
			try {
				for await (const message of underlying) {
					yield message;
				}
				const failure = renewalFailure();
				if (failure) throw new SandboxRenewalError(failure.error);
			} catch (error) {
				// A renewal failure explains any stream error it caused (the linked
				// abort surfaces as an opaque AbortError); report the cause instead.
				const failure = renewalFailure();
				if (failure && !(error instanceof SandboxRenewalError)) {
					throw new SandboxRenewalError(failure.error);
				}
				throw error;
			} finally {
				settle();
			}
		},
	};
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
