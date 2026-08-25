import { createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import {
	loadAgentQueryWorkspaceTx,
	publishAgentQueryWorkspaceTx,
	recordOrphanSandboxTx,
} from "@mymemo/agent-db/runtime-store";
import type { SandboxProvisioner } from "../../agentcore-runtime/src/e2b/sandbox-provisioner";
import { DEFAULT_FILE_TOOL_LIMITS } from "../../agentcore-runtime/src/file-tools/file-tools";
import { toMessage } from "../../agentcore-runtime/src/logger";
import { startSandboxRenewal } from "../../agentcore-runtime/src/sdk/sandbox-renewal";
import {
	buildWorkspaceFileTools,
	EXECUTOR_SERVER_NAME,
	WORKSPACE_FILE_TOOL_NAMES,
} from "../../agentcore-runtime/src/sdk/workspace-tools";

const ORPHAN_RUN_ID = "agent-query";
const WORKER_ID = "agent-query-runtime";

export function createAgentQueryWorkspacePreparer(deps: {
	db: Database;
	provisioner: SandboxProvisioner;
	sandboxIdleMs: number;
	logger: {
		warn(value: Record<string, unknown>): void;
	};
}) {
	return async (conversation: {
		conversationId: string;
		conversationEpoch: number;
	}) => {
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
					...conversation,
					sandboxId: workspace.sandboxId,
				});
			} catch (error) {
				workspace.dispose();
				try {
					await recordOrphanSandboxTx(deps.db, {
						sandboxId: workspace.sandboxId,
						userId: workspaceState.userId,
						conversationId: conversation.conversationId,
						runId: ORPHAN_RUN_ID,
						createdByWorkerId: WORKER_ID,
						reason: "Agent-query Workspace publication failed",
					});
				} catch (recordError) {
					deps.logger.warn({
						message: "could not record unpublished Agent-query Workspace",
						sandboxId: workspace.sandboxId,
						error: toMessage(recordError),
					});
				}
				throw error;
			}
			if (workspaceState.sandboxId !== null) {
				try {
					await recordOrphanSandboxTx(deps.db, {
						sandboxId: workspaceState.sandboxId,
						userId: workspaceState.userId,
						conversationId: conversation.conversationId,
						runId: ORPHAN_RUN_ID,
						createdByWorkerId: WORKER_ID,
						reason: workspaceState.sandboxTainted
							? "tainted Agent-query Workspace replaced"
							: "unreachable Agent-query Workspace replaced",
					});
				} catch (error) {
					deps.logger.warn({
						message: "could not record replaced Agent-query Workspace",
						sandboxId: workspaceState.sandboxId,
						error: toMessage(error),
					});
				}
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
		return {
			signal: controller.signal,
			queryOptions: {
				allowedTools: WORKSPACE_FILE_TOOL_NAMES.map(
					(name) => `mcp__${EXECUTOR_SERVER_NAME}__${name}`,
				),
				mcpServers: {
					[EXECUTOR_SERVER_NAME]: createSdkMcpServer({
						name: EXECUTOR_SERVER_NAME,
						alwaysLoad: true,
						tools: buildWorkspaceFileTools({
							workspaceRoot: workspace.workspaceRoot,
							fileClient: workspace.fileClient,
							fileLimits: DEFAULT_FILE_TOOL_LIMITS,
							signal: controller.signal,
						}),
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
