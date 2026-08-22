import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";

export interface StatsigClientLike {
	initialize(): Promise<unknown>;
	checkGate(user: StatsigUser, gateName: string): boolean;
}

interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

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
	private readonly ready: Promise<boolean>;

	constructor(
		private readonly client: StatsigClientLike,
		private readonly logger?: GateLogger,
	) {
		this.ready = client
			.initialize()
			.then(() => true)
			.catch((error) => {
				logger?.error({
					message: "Statsig initialization failed; failing closed",
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			});
	}

	async isAgentEnabled(identity: InternalIdentity): Promise<boolean> {
		if (!(await this.ready)) return false;
		try {
			return this.client.checkGate(
				new StatsigUser({
					userID: identity.memberCode,
					customIDs: { partnerCode: identity.partnerCode },
					custom: {
						partnerCode: identity.partnerCode,
						...(identity.teamCode ? { teamCode: identity.teamCode } : {}),
					},
				}),
				AGENT_EXPOSURE_GATE,
			);
		} catch (error) {
			this.logger?.error({
				message: "Statsig gate evaluation failed; failing closed",
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}
}

/**
 * Construct the real Statsig-backed gate. Kicks off initialization immediately;
 * the first `isAgentEnabled` awaits it.
 */
export function createStatsigExposureGate(
	serverSecret: string,
	logger?: GateLogger,
): StatsigExposureGate {
	return new StatsigExposureGate(
		new Statsig(serverSecret, { outputLogLevel: "warn" }),
		logger,
	);
}
