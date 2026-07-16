import { Sandbox } from "e2b";
import type { ArtifactWorkspace } from "../artifacts/artifact-publication";
import {
	type ArtifactSandbox,
	createE2bArtifactWorkspace,
} from "../artifacts/artifact-workspace";
import type { SandboxCommandClient } from "../bash-tool/bash-tool";
import { DEFAULT_COMMAND_CONTROL_DIR } from "../bash-tool/bash-wrapper";
import type { SandboxFileClient } from "../file-tools/file-tools";
import type { WorkerLogger } from "../logger";
import { type CommandSandbox, E2BCommandClient } from "./command-client";
import { E2BFileClient, type FileSandbox } from "./file-client";

/**
 * The sandbox workspace root every run's file and shell work resolves under:
 * the E2B user home. Distinct from the SDK query's Fargate-side working
 * directory (a per-conversation session anchor) — never conflate the two
 * filesystems.
 */
export const SANDBOX_WORKSPACE_ROOT = "/home/user";

/** What provisioning needs to know about the conversation's workspace: the
 * `conversation_runtime` sandbox pointer and its taint state, plus the identity
 * used to attribute a newly created sandbox. Reading the pointer and persisting
 * a replacement are the caller's (fenced) responsibility. */
export interface ProvisionForRunInput {
	userId: string;
	conversationId: string;
	/** The conversation's current sandbox, or `null` when it has none yet. */
	sandboxId: string | null;
	sandboxTainted: boolean;
}

/**
 * One run's ready-to-use workspace handle (plan Task 9.4, shape fixed by the
 * spec). The clients are bound to the live sandbox; `renew()` extends its idle
 * window while the turn is active.
 */
export interface ProvisionedSandbox {
	sandboxId: string;
	/** `true` when a fresh sandbox was created — the pointer was unset, tainted,
	 * or connecting failed — so the caller must repoint the conversation. */
	isNew: boolean;
	workspaceRoot: string;
	commandClient: SandboxCommandClient;
	fileClient: SandboxFileClient;
	artifactWorkspace: ArtifactWorkspace;
	/** Extend the sandbox's idle window to now + the configured idle timeout. */
	renew(): Promise<void>;
	/**
	 * Stop renewal so the sandbox idle-pauses (ADR-0007: the paused sandbox IS
	 * the persisted workspace). Never kills the live workspace; after dispose a
	 * straggling `renew()` is inert rather than extending the sandbox.
	 */
	dispose(): void;
}

/**
 * The one seam every E2B side effect lives behind (spec Milestone 9): run
 * orchestration is written against this interface and tested with a fake, so
 * fencing, orphan recording, and renewal logic never need credentials.
 */
export interface SandboxProvisioner {
	provisionForRun(input: ProvisionForRunInput): Promise<ProvisionedSandbox>;
}

/** The slice of an E2B `Sandbox` a provisioned handle holds. */
export interface ProvisionerSandbox extends CommandSandbox {
	readonly sandboxId: string;
	commands: CommandSandbox["commands"] & ArtifactSandbox["commands"];
	files: FileSandbox["files"] & ArtifactSandbox["files"];
	setTimeout(timeoutMs: number): Promise<void>;
}

export interface SandboxProvisionerDeps {
	/** Idle window each connect/create/renew grants; unrenewed, the sandbox
	 * pauses this long after the last extension. */
	sandboxIdleMs: number;
	logger: WorkerLogger;
	/** Connect to (and auto-resume) an existing sandbox. */
	connectSandbox(sandboxId: string): Promise<ProvisionerSandbox>;
	/** Create a fresh sandbox from the pinned template. */
	createSandbox(input: {
		userId: string;
		conversationId: string;
	}): Promise<ProvisionerSandbox>;
}

/**
 * Connect-or-create provisioning over injected sandbox constructors
 * (ADR-0007): pointer set and not tainted → connect (auto-resume, files
 * intact); connect failure or a tainted pointer → fresh sandbox from the
 * pinned template. A tainted sandbox is never reused, and the provisioner
 * never kills one — replacement bookkeeping (fenced repoint, orphan record)
 * belongs to the caller, which sees `isNew` against the pointer it passed.
 */
export function createSandboxProvisioner(
	deps: SandboxProvisionerDeps,
): SandboxProvisioner {
	return {
		async provisionForRun(input) {
			if (input.sandboxId !== null && !input.sandboxTainted) {
				try {
					const sandbox = await deps.connectSandbox(input.sandboxId);
					return provisionedHandle(sandbox, false, deps.sandboxIdleMs);
				} catch (error) {
					deps.logger.warn({
						message: "sandbox connect failed; provisioning a fresh sandbox",
						sandboxId: input.sandboxId,
						conversationId: input.conversationId,
						error: toMessage(error),
					});
				}
			}
			const sandbox = await deps.createSandbox({
				userId: input.userId,
				conversationId: input.conversationId,
			});
			return provisionedHandle(sandbox, true, deps.sandboxIdleMs);
		},
	};
}

function provisionedHandle(
	sandbox: ProvisionerSandbox,
	isNew: boolean,
	sandboxIdleMs: number,
): ProvisionedSandbox {
	let disposed = false;
	return {
		sandboxId: sandbox.sandboxId,
		isNew,
		workspaceRoot: SANDBOX_WORKSPACE_ROOT,
		commandClient: new E2BCommandClient(sandbox, DEFAULT_COMMAND_CONTROL_DIR),
		fileClient: new E2BFileClient(sandbox),
		artifactWorkspace: createE2bArtifactWorkspace(sandbox),
		renew: async () => {
			if (disposed) return;
			await sandbox.setTimeout(sandboxIdleMs);
		},
		dispose: () => {
			disposed = true;
		},
	};
}

export interface E2bSandboxProvisionerConfig {
	apiKey: string;
	/** The pinned E2B template id fresh sandboxes are created from (Task 9.2:
	 * ships the `rg`/`python3` the Grep/Glob tools shell out to). */
	template: string;
	sandboxIdleMs: number;
	logger: WorkerLogger;
}

/** {@link createSandboxProvisioner} wired to the real E2B SDK. */
export function createE2bSandboxProvisioner(
	config: E2bSandboxProvisionerConfig,
): SandboxProvisioner {
	return createSandboxProvisioner({
		sandboxIdleMs: config.sandboxIdleMs,
		logger: config.logger,
		connectSandbox: (sandboxId) =>
			Sandbox.connect(sandboxId, {
				apiKey: config.apiKey,
				timeoutMs: config.sandboxIdleMs,
			}),
		createSandbox: (input) =>
			Sandbox.create(config.template, {
				apiKey: config.apiKey,
				timeoutMs: config.sandboxIdleMs,
				// Idle timeout pauses the workspace instead of killing it; the next
				// turn's connect auto-resumes it with files intact (ADR-0007).
				lifecycle: { onTimeout: "pause" },
				metadata: {
					userId: input.userId,
					conversationId: input.conversationId,
				},
			}),
	});
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
