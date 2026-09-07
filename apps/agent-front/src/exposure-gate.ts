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
 * Initialize only inside a gated invocation: Lambda can freeze between module
 * initialization and the first handler. A failed attempt denies that request
 * but must not poison the execution environment for subsequent invocations.
 */
export class StatsigExposureGate implements ExposureGate {
	private ready?: Promise<boolean>;

	constructor(
		private readonly client: StatsigClientLike,
		private readonly logger?: GateLogger,
	) {}

	async isAgentEnabled(identity: InternalIdentity): Promise<boolean> {
		this.ready ??= this.client
			.initialize()
			.then((result) => result.isSuccess)
			.catch((error) => {
				this.logger?.error({
					message: "Statsig initialization failed; failing closed",
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			});
		const ready = this.ready;
		if (!(await ready)) {
			if (this.ready === ready) this.ready = undefined;
			return false;
		}
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
