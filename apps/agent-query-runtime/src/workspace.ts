import type { Database } from "@mymemo/agent-db/client";
import {
	type DirectResponseOwner,
	loadDirectResponseWorkspaceTx,
	markDirectResponseWorkspaceTaintedTx,
	publishDirectResponseWorkspaceTx,
} from "@mymemo/agent-db/direct-response";
import {
	type BashToolLimits,
	DEFAULT_BASH_TOOL_LIMITS,
} from "../../agentcore-runtime/src/bash-tool/bash-tool";
import type { SandboxProvisioner } from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import type { FileToolLimits } from "../../agentcore-runtime/src/file-tools/file-tools";
import {
	createWorkspaceMcpServer,
	EXECUTOR_SERVER_NAME,
	WORKSPACE_ALLOWED_TOOLS,
} from "../../agentcore-runtime/src/sdk/workspace-tools";
import type { AgentQueryWorkspace } from "./server";

export const DIRECT_RESPONSE_FILE_LIMITS: FileToolLimits = {
	readMaxBytes: 65_536,
	readMaxLines: 2_000,
	grepMaxResults: 100,
	commandMaxOutputBytes: 65_536,
	commandTimeoutMs: 30_000,
};

type Logger = {
	info(value: Record<string, unknown>): void;
	warn(value: Record<string, unknown>): void;
};

export function createDirectResponseWorkspacePreparer(deps: {
	db: Database;
	provisioner: SandboxProvisioner;
	logger: Logger;
	fileLimits?: FileToolLimits;
	bashLimits?: BashToolLimits;
}) {
	return async (owner: DirectResponseOwner): Promise<AgentQueryWorkspace> => {
		const current = await loadDirectResponseWorkspaceTx(deps.db, owner);
		const workspace = await deps.provisioner.provisionForRun({
			userId: current.userId,
			conversationId: owner.conversationId,
			sandboxId: current.sandboxId,
			sandboxTainted: current.sandboxTainted,
		});
		if (workspace.isNew) {
			await publishDirectResponseWorkspaceTx(deps.db, {
				...owner,
				userId: current.userId,
				sandboxId: workspace.sandboxId,
			});
		}

		const controller = new AbortController();
		const binding = {
			userId: current.userId,
			conversationId: owner.conversationId,
			runId: `direct-response-${owner.conversationEpoch}`,
			sandboxId: workspace.sandboxId,
		};
		return {
			queryOptions: {
				allowedTools: [...WORKSPACE_ALLOWED_TOOLS],
				mcpServers: {
					[EXECUTOR_SERVER_NAME]: createWorkspaceMcpServer({
						binding,
						workspaceRoot: workspace.workspaceRoot,
						signal: controller.signal,
						fileClient: workspace.fileClient,
						commandClient: workspace.commandClient,
						fileLimits: deps.fileLimits ?? DIRECT_RESPONSE_FILE_LIMITS,
						bashLimits: deps.bashLimits ?? DEFAULT_BASH_TOOL_LIMITS,
						async markSandboxTainted(reason) {
							deps.logger.warn({
								message: "marking direct-response Workspace tainted",
								...binding,
								reason,
							});
							await markDirectResponseWorkspaceTaintedTx(deps.db, {
								...owner,
								userId: current.userId,
							});
						},
						async recordCommandAudit(event) {
							deps.logger.info({ message: "bash command audit", ...event });
						},
					}),
				},
			},
			async stop() {
				controller.abort();
			},
			dispose() {
				workspace.dispose();
			},
		};
	};
}
