import {
	AGENTCORE_EXECUTION_RUNTIME,
	type ConversationExecutionRuntime,
	FARGATE_EXECUTION_RUNTIME,
} from "@mymemo/agent-db/execution-runtime";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";
import {
	createStatsigClient,
	type GateLogger,
	StatsigBooleanGate,
	type StatsigClientLike,
} from "@/features/statsig-gate";

export type { StatsigClientLike } from "@/features/statsig-gate";

/** Dedicated server-side gate for immutable Conversation runtime selection. */
export const AGENTCORE_RUNTIME_GATE = "mymemo_agent_agentcore_runtime_enabled";

export interface RuntimeGate {
	selectRuntime(
		identity: InternalIdentity,
	): Promise<ConversationExecutionRuntime>;
}

/** Operator break-glass keeps new Conversations on the proven Fargate path. */
export class BreakGlassRuntimeGate implements RuntimeGate {
	async selectRuntime(
		_identity: InternalIdentity,
	): Promise<ConversationExecutionRuntime> {
		return FARGATE_EXECUTION_RUNTIME;
	}
}

export class StatsigRuntimeGate implements RuntimeGate {
	private readonly gate: StatsigBooleanGate;

	constructor(client: StatsigClientLike, logger?: GateLogger) {
		this.gate = new StatsigBooleanGate(
			client,
			AGENTCORE_RUNTIME_GATE,
			{
				initialization:
					"Statsig runtime gate initialization failed; selecting Fargate",
				evaluation: "Statsig runtime gate evaluation failed; selecting Fargate",
			},
			logger,
		);
	}

	async selectRuntime(
		identity: InternalIdentity,
	): Promise<ConversationExecutionRuntime> {
		return (await this.gate.isEnabled(identity))
			? AGENTCORE_EXECUTION_RUNTIME
			: FARGATE_EXECUTION_RUNTIME;
	}
}

export function createStatsigRuntimeGate(
	serverSecret: string,
	options: { environment?: string } = {},
	logger?: GateLogger,
): StatsigRuntimeGate {
	return new StatsigRuntimeGate(
		createStatsigClient(serverSecret, options),
		logger,
	);
}
