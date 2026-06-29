import { Statsig, StatsigUser } from "@statsig/statsig-node-core";
import type { InternalIdentity } from "@/features/conversations/conversations.schema";

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
 * Operator break-glass gate: always allows. Used for local dev and for incident
 * response when Statsig is unavailable and an operator has explicitly opted in
 * via `AGENT_EXPOSURE_BREAK_GLASS=true`. Never the production default.
 */
export class BreakGlassExposureGate implements ExposureGate {
	async isAgentEnabled(): Promise<boolean> {
		return true;
	}
}

/**
 * The narrow slice of the Statsig client the gate depends on. Lets tests inject
 * a fake for fail-closed paths while production passes the real `Statsig`.
 */
export interface StatsigClientLike {
	initialize(): Promise<unknown>;
	checkGate(user: StatsigUser, gateName: string): boolean;
}

/** Minimal logger seam; the route logger satisfies it. */
interface GateLogger {
	error(obj: Record<string, unknown>): void;
}

/**
 * Statsig-backed production gate. Fails CLOSED: if initialization fails or an
 * evaluation throws, new work is denied. The Statsig secret is never logged.
 */
export class StatsigExposureGate implements ExposureGate {
	/** Resolves true once Statsig is initialized; false if init failed. */
	private readonly ready: Promise<boolean>;

	constructor(
		private readonly client: StatsigClientLike,
		private readonly logger?: GateLogger,
	) {
		this.ready = client
			.initialize()
			.then(() => true)
			.catch((error) => {
				this.logger?.error({
					message: "Statsig initialization failed; failing closed",
					error: error instanceof Error ? error.message : String(error),
				});
				return false;
			});
	}

	async isAgentEnabled(identity: InternalIdentity): Promise<boolean> {
		if (!(await this.ready)) return false;
		try {
			const user = buildStatsigUser(identity);
			return this.client.checkGate(user, AGENT_EXPOSURE_GATE);
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
 * Build the Statsig user from trusted identity headers only. `memberCode` is the
 * stable user id; partner/team ride along as targeting attributes. Body fields
 * never reach here — the route derives identity from headers.
 */
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
	const statsig = new Statsig(serverSecret, {
		environment: options.environment,
		outputLogLevel: "warn",
	});
	return new StatsigExposureGate(
		statsig as unknown as StatsigClientLike,
		logger,
	);
}
