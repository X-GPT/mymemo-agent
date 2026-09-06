import { StatsigUser } from "@statsig/statsig-node-core";
import type { InternalIdentity } from "./schema";

export interface StatsigClientLike {
	initialize(): Promise<{ isSuccess: boolean }>;
	checkGate(user: StatsigUser, gateName: string): boolean;
}

interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

/** The server-side gate name that controls split-runtime agent exposure. */
export const AGENT_EXPOSURE_GATE = "mymemo_agent_split_runtime_enabled";

// Copied from chat-api. Only new work consults this gate.
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
			.then((result) => result.isSuccess)
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
