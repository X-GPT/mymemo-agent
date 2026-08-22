import type { InternalIdentity } from "@/features/conversations/conversations.schema";
import {
	createStatsigClient,
	type GateLogger,
	StatsigBooleanGate,
	type StatsigClientLike,
} from "@/features/statsig-gate";

export type { StatsigClientLike } from "@/features/statsig-gate";

/** The server-side gate name that controls split-runtime agent exposure. */
export const AGENT_EXPOSURE_GATE = "mymemo_agent_split_runtime_enabled";

/**
 * Decides whether a trusted internal identity may create new agent work.
 * Evaluated in `chat-api` after identity headers are parsed and before any
 * conversation/run write. It does NOT replace auth, ownership checks, DB
 * invariants, or worker fencing — it only controls new-work exposure.
 *
 * Reconnect and interrupt for existing owned runs must not depend on this gate.
 */
export interface ExposureGate {
	isAgentEnabled(identity: InternalIdentity): Promise<boolean>;
}

/**
 * Statsig-backed production gate. Fails CLOSED: if initialization fails or an
 * evaluation throws, new work is denied. The Statsig secret is never logged.
 *
 * Initialization is kicked off in the constructor and awaited on the first
 * `isAgentEnabled`, so it overlaps boot (the gate is warm before the first
 * turn).
 */
export class StatsigExposureGate implements ExposureGate {
	private readonly gate: StatsigBooleanGate;

	constructor(client: StatsigClientLike, logger?: GateLogger) {
		this.gate = new StatsigBooleanGate(
			client,
			AGENT_EXPOSURE_GATE,
			{
				initialization: "Statsig initialization failed; failing closed",
				evaluation: "Statsig gate evaluation failed; failing closed",
			},
			logger,
		);
	}

	async isAgentEnabled(identity: InternalIdentity): Promise<boolean> {
		return this.gate.isEnabled(identity);
	}
}

/**
 * Construct the real Statsig-backed gate. Kicks off initialization immediately;
 * the first `isAgentEnabled` awaits it. `environment` tiers the gate (e.g.
 * "production") so rollout cohorts can differ per environment.
 */
export function createStatsigExposureGate(
	serverSecret: string,
	options: { environment?: string } = {},
	logger?: GateLogger,
): StatsigExposureGate {
	return new StatsigExposureGate(
		createStatsigClient(serverSecret, options),
		logger,
	);
}
