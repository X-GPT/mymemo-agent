import { eq } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import {
	AGENTCORE_CANARY_EXECUTION_LANE,
	FARGATE_EXECUTION_LANE,
} from "./execution-lane";
import { conversations, executionLaneDeployments } from "./schema";

/**
 * Gate the later canary-creation transaction on the durable record written only
 * after ECS has fully converged to a lane-aware Fargate task definition. The
 * row lock composes with the rollback transaction, so creation and rollback
 * cannot both pass from the same previously-ready state.
 */
export async function assertAgentCoreCanaryCreationReady(
	tx: DbTx,
): Promise<void> {
	const [deployment] = await tx
		.select({ laneAware: executionLaneDeployments.laneAware })
		.from(executionLaneDeployments)
		.where(eq(executionLaneDeployments.executionLane, FARGATE_EXECUTION_LANE))
		.for("update");
	if (!deployment?.laneAware) {
		throw new Error(
			"Fargate deployment is not fully execution-lane-aware; AgentCore-canary creation is disabled",
		);
	}
}

/** Record readiness after the rollout has proved service/task convergence. */
export async function markFargateLaneAwareDeploymentReady(
	db: Database,
): Promise<void> {
	await db
		.insert(executionLaneDeployments)
		.values({
			executionLane: FARGATE_EXECUTION_LANE,
			laneAware: true,
		})
		.onConflictDoUpdate({
			target: executionLaneDeployments.executionLane,
			set: { laneAware: true, updatedAt: new Date() },
		});
}

/**
 * A lane-aware candidate is always safe. A lane-unaware rollback is safe only
 * after canary cleanup has removed every AgentCore-canary Conversation; the
 * additive lane column deliberately remains in place.
 */
export async function assertFargateRollbackAllowed(
	db: Database,
	input: { candidateLaneAware: boolean },
): Promise<void> {
	if (input.candidateLaneAware) return;
	await db.transaction(async (tx) => {
		await tx
			.insert(executionLaneDeployments)
			.values({
				executionLane: FARGATE_EXECUTION_LANE,
				laneAware: false,
			})
			.onConflictDoUpdate({
				target: executionLaneDeployments.executionLane,
				set: { laneAware: false, updatedAt: new Date() },
			});
		const [agentCoreConversation] = await tx
			.select({ conversationId: conversations.conversationId })
			.from(conversations)
			.where(eq(conversations.executionLane, AGENTCORE_CANARY_EXECUTION_LANE))
			.limit(1);
		if (agentCoreConversation) {
			throw new Error(
				"lane-unaware Fargate rollback refused while AgentCore-canary Conversations exist",
			);
		}
	});
}
