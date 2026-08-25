import type { Database } from "@mymemo/agent-db/client";
import {
	loadAgentQueryWorkspaceTx,
	markAgentQueryWorkspaceTaintedTx,
	publishAgentQueryWorkspaceTx,
} from "@mymemo/agent-db/runtime-store";
import { DEFAULT_BASH_TOOL_LIMITS } from "../../agentcore-runtime/src/bash-tool/bash-tool";
import type { SandboxProvisioner } from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import { DEFAULT_FILE_TOOL_LIMITS } from "../../agentcore-runtime/src/file-tools/file-tools";
import { startSandboxRenewal } from "../../agentcore-runtime/src/sdk/sandbox-renewal";
import {
	createWorkspaceMcpServer,
	EXECUTOR_SERVER_NAME,
	WORKSPACE_ALLOWED_TOOLS,
} from "../../agentcore-runtime/src/sdk/workspace-tools";
import type { AgentQueryWorkspace } from "./server";

export function createAgentQueryWorkspacePreparer(deps: {
	db: Database;
	provisioner: SandboxProvisioner;
	sandboxIdleMs: number;
	logger: {
		info(value: Record<string, unknown>): void;
		warn(value: Record<string, unknown>): void;
	};
}) {
	return async (conversation: {
		conversationId: string;
		conversationEpoch: number;
	}): Promise<AgentQueryWorkspace> => {
		const workspaceState = await loadAgentQueryWorkspaceTx(
			deps.db,
			conversation.conversationId,
		);
		const workspace = await deps.provisioner.provisionForRun({
			userId: workspaceState.userId,
			conversationId: conversation.conversationId,
			sandboxId: workspaceState.sandboxId,
			sandboxTainted: workspaceState.sandboxTainted,
		});
		if (workspace.isNew) {
			try {
				await publishAgentQueryWorkspaceTx(deps.db, {
					userId: workspaceState.userId,
					conversationId: conversation.conversationId,
					sandboxId: workspace.sandboxId,
				});
			} catch (error) {
				workspace.dispose();
				throw error;
			}
		}

		const controller = new AbortController();
		const renewal = startSandboxRenewal({
			renew: () => workspace.renew(),
			intervalMs: Math.max(1, Math.floor(deps.sandboxIdleMs / 2)),
			onFailure(error) {
				deps.logger.warn({
					message: "Agent-query Workspace renewal failed",
					conversationId: conversation.conversationId,
					sandboxId: workspace.sandboxId,
				});
				controller.abort(error);
			},
		});
		// The reused Bash audit shape calls this field runId; no durable Run exists.
		const auditBinding = {
			userId: workspaceState.userId,
			conversationId: conversation.conversationId,
			runId: `agent-query-${conversation.conversationEpoch}`,
			sandboxId: workspace.sandboxId,
		};
		return {
			signal: controller.signal,
			queryOptions: {
				allowedTools: [...WORKSPACE_ALLOWED_TOOLS],
				mcpServers: {
					[EXECUTOR_SERVER_NAME]: createWorkspaceMcpServer({
						binding: auditBinding,
						workspaceRoot: workspace.workspaceRoot,
						signal: controller.signal,
						fileClient: workspace.fileClient,
						commandClient: workspace.commandClient,
						fileLimits: DEFAULT_FILE_TOOL_LIMITS,
						bashLimits: DEFAULT_BASH_TOOL_LIMITS,
						async markSandboxTainted(reason) {
							deps.logger.warn({
								message: "marking Agent-query Workspace tainted",
								...auditBinding,
								reason,
							});
							await markAgentQueryWorkspaceTaintedTx(deps.db, {
								userId: workspaceState.userId,
								conversationId: conversation.conversationId,
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
				renewal.stop();
			},
			dispose() {
				renewal.stop();
				workspace.dispose();
			},
		};
	};
}
