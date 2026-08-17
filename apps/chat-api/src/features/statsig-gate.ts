import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";

/** The narrow Statsig client surface used by server-side gates. */
export interface StatsigClientLike {
	initialize(): Promise<unknown>;
	checkGate(user: StatsigUser, gateName: string): boolean;
}

export interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

interface StatsigGateErrorMessages {
	initialization: string;
	evaluation: string;
}

/**
 * Shared Statsig adapter for boolean gates. Initialization overlaps boot, and
 * every SDK failure resolves false so each owning feature can apply its own
 * fail-closed or fail-safe policy without duplicating client mechanics.
 */
export class StatsigBooleanGate {
	private readonly ready: Promise<boolean>;

	constructor(
		private readonly client: StatsigClientLike,
		private readonly gateName: string,
		private readonly messages: StatsigGateErrorMessages,
		private readonly logger?: GateLogger,
	) {
		this.ready = client
			.initialize()
			.then(() => true)
			.catch((error) => {
				this.logger?.error({
					message: messages.initialization,
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			});
	}

	async isEnabled(identity: InternalIdentity): Promise<boolean> {
		if (!(await this.ready)) return false;
		try {
			return this.client.checkGate(buildStatsigUser(identity), this.gateName);
		} catch (error) {
			this.logger?.error({
				message: this.messages.evaluation,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}
}

function buildStatsigUser(identity: InternalIdentity): StatsigUser {
	return new StatsigUser({
		userID: identity.memberCode,
		customIDs: { partnerCode: identity.partnerCode },
		custom: {
			partnerCode: identity.partnerCode,
			...(identity.teamCode ? { teamCode: identity.teamCode } : {}),
		},
	});
}

export function createStatsigClient(
	serverSecret: string,
	options: { environment?: string } = {},
): StatsigClientLike {
	return new Statsig(serverSecret, {
		environment: options.environment,
		outputLogLevel: "warn",
	}) as unknown as StatsigClientLike;
}
