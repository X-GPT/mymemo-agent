import { eq } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	AGENTCORE_EXECUTION_RUNTIME,
	FARGATE_EXECUTION_RUNTIME,
} from "./execution-runtime";
import { conversations, executionRuntimeDeployments } from "./schema";

async function setFargateRuntimeAwareness(
	tx: DbTx,
	runtimeAware: boolean,
): Promise<void> {
	await tx
		.insert(executionRuntimeDeployments)
		.values({ executionRuntime: FARGATE_EXECUTION_RUNTIME, runtimeAware })
		.onConflictDoUpdate({
			target: executionRuntimeDeployments.executionRuntime,
			set: { runtimeAware, updatedAt: new Date() },
		});
}

/**
 * Gate AgentCore creation on the durable record written only after ECS has
 * fully converged to a runtime-aware Fargate task definition. The row lock
 * composes with the deployment-compatibility transaction, so creation and a
 * runtime-unaware deployment cannot both pass from the same previously-ready
 * state.
 */
export async function assertAgentCoreCreationReady(tx: DbTx): Promise<void> {
	const [deployment] = await tx
		.select({ runtimeAware: executionRuntimeDeployments.runtimeAware })
		.from(executionRuntimeDeployments)
		.where(
			eq(
				executionRuntimeDeployments.executionRuntime,
				FARGATE_EXECUTION_RUNTIME,
			),
		)
		.for("update");
	if (!deployment?.runtimeAware) {
		throw new Error(
			"Fargate deployment is not fully execution-runtime-aware; AgentCore creation is disabled",
		);
	}
}

/** Record readiness after the rollout has proved service/task convergence. */
export async function markFargateRuntimeAwareDeploymentReady(
	db: Database,
): Promise<void> {
	await db.transaction(async (tx) => setFargateRuntimeAwareness(tx, true));
}

/**
 * A runtime-aware candidate preserves readiness. Before a runtime-unaware
 * candidate may deploy, atomically clear readiness and require that no
 * AgentCore Conversation depends on the capability it lacks. This is a
 * compatibility guard, not an incident-recovery or Conversation-cleanup path.
 */
export async function prepareFargateDeploymentCompatibility(
	db: Database,
	input: { candidateRuntimeAware: boolean },
): Promise<void> {
	if (input.candidateRuntimeAware) return;
	await db.transaction(async (tx) => {
		await setFargateRuntimeAwareness(tx, false);
		const [agentCoreConversation] = await tx
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(eq(conversations.executionRuntime, AGENTCORE_EXECUTION_RUNTIME))
			.limit(1);
		if (agentCoreConversation) {
			throw new Error(
				"runtime-unaware Fargate deployment is incompatible while AgentCore Conversations exist",
			);
		}
	});
}
