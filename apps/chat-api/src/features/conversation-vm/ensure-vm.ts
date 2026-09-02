import type { Logger } from "pino";
import { mintGatewayToken } from "@/features/gateway/gateway-token";
import type {
	ConversationRef,
	ConversationVmStore,
} from "./conversation-vm-store";
import {
	IN_VM_SERVER_PORT,
	type MicrovmControlPlane,
} from "./microvm-control-plane";

/**
 * Ensure-VM (spec #654, ticket #669): make the Conversation's VM serve its
 * queue. Called by the message POST after the `queued` INSERT and after
 * subscribing to the Turn's Live Stream. Resolves once the VM is running or
 * launching; rejects with {@link VmUnavailableError} only when a launch this
 * caller owned failed after the SDK's retries — the retryable 503.
 */
export type EnsureVm = (
	ref: ConversationRef,
	logger: EnsureVmLogger,
) => Promise<void>;

/** The request logger (hono-pino's, or any pino-shaped one). */
export type EnsureVmLogger = Pick<Logger, "info" | "warn" | "error">;

/** A launch failed after retries; the client should retry the POST later. */
export class VmUnavailableError extends Error {
	constructor(options: { cause: unknown }) {
		super("MicroVM launch failed", options);
		this.name = "VmUnavailableError";
	}
}

/**
 * A `launching` claim older than this with no VM recorded belonged to a
 * chat-api that died mid-launch; the next caller re-claims it.
 */
export const STALE_LAUNCH_MS = 2 * 60_000;
const NUDGE_TIMEOUT_MS = 10_000;

export interface EnsureVmDeps {
	store: ConversationVmStore;
	controlPlane: MicrovmControlPlane;
	/**
	 * Everything the In-VM server's `runHookPayload` carries besides the
	 * Conversation identity and the minted gateway token. Data-plane URLs ride
	 * the payload into the trusted in-VM process only (ADR-0034).
	 */
	payload: {
		agentDatabaseUrl: string;
		kbDatabaseUrl: string;
		redisUrl: string;
		/** The chat-api origin the VM reaches the `/v2/gateway` route on. */
		gatewayBaseUrl: string;
		model: string;
	};
	gatewayTokenSecret: string;
	/**
	 * True converts the next nudge of a VM on a stale image into a rehydrate
	 * (#650's urgent lever); false leaves upgrades to natural rotation.
	 */
	upgradeUrgent: boolean;
	fetch: typeof fetch;
}

export function createEnsureVm(deps: EnsureVmDeps): EnsureVm {
	const { store, controlPlane } = deps;

	return (ref, logger) => {
		// The platform caps the payload at 4 KB; its own validation rejects an
		// oversize one into the launch-failure path below.
		function runHookPayload(ref: ConversationRef, gatewayToken: string) {
			return JSON.stringify({
				MYMEMO_USER_ID: ref.userId,
				MYMEMO_CONVERSATION_ID: ref.conversationId,
				AGENT_DATABASE_URL: deps.payload.agentDatabaseUrl,
				KB_DATABASE_URL: deps.payload.kbDatabaseUrl,
				REDIS_URL: deps.payload.redisUrl,
				MODEL_BASE_URL: `${deps.payload.gatewayBaseUrl}/v2/gateway/${ref.conversationId}`,
				MODEL_API_KEY: gatewayToken,
				MODEL: deps.payload.model,
			});
		}

		/** This caller owns the `launching` claim: mint, launch, record. */
		async function launch(ref: ConversationRef): Promise<void> {
			let vm: Awaited<ReturnType<MicrovmControlPlane["run"]>>;
			try {
				const gatewayToken = await mintGatewayToken({
					conversationId: ref.conversationId,
					secret: deps.gatewayTokenSecret,
				});
				vm = await controlPlane.run({
					runHookPayload: runHookPayload(ref, gatewayToken),
				});
			} catch (error) {
				// Hand the claim back now rather than after the stale window, so the
				// client's retry can launch immediately. A RunMicrovm that succeeded
				// on the platform but failed to answer leaves an orphan the idle
				// policy winds down — accepted; the orphan sweeper is deferred.
				await store.releaseClaim(ref).catch((releaseError) => {
					logger.error(
						{ ...ref, err: releaseError },
						"VM claim release failed",
					);
				});
				logger.error({ ...ref, err: error }, "RunMicrovm failed after retries");
				throw new VmUnavailableError({ cause: error });
			}
			await store.recordLaunched(ref, vm);
			logger.info({ ...ref, ...vm }, "MicroVM launched");
			// No nudge: the In-VM server's drain loop starts inside the /run hook and
			// consumes the queue itself, and the platform holds endpoint traffic
			// until that hook returns.
		}

		/** Nudge a `running` VM; a suspended one auto-resumes under the platform. */
		async function nudge(
			ref: ConversationRef,
			row: { microvmId: string; endpoint: string },
		): Promise<"nudged" | "gone"> {
			try {
				// ponytail: one token mint per nudge; cache per VM if the control-plane
				// call rate ever matters.
				const token = await controlPlane.createAuthToken(row.microvmId);
				const response = await deps.fetch(`https://${row.endpoint}/nudge`, {
					method: "POST",
					headers: {
						"x-aws-proxy-auth": token,
						"x-aws-proxy-port": String(IN_VM_SERVER_PORT),
					},
					signal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(`nudge answered ${response.status}`);
				await store.touchActivity(ref);
				return "nudged";
			} catch (error) {
				// Reactive at-cap handling: the platform may have ended the VM (8 h
				// cap, a failed boot). Only its own word marks the row terminated —
				// a booting or suspending VM keeps its row, and its interval
				// self-heal drains the queue without this nudge.
				const state = await controlPlane
					.getState(row.microvmId)
					.catch(() => "unknown" as const);
				if (
					state === "TERMINATED" ||
					state === "TERMINATING" ||
					state === "not-found"
				) {
					logger.warn(
						{ ...ref, microvmId: row.microvmId, state },
						"MicroVM gone; rehydrating on the next claim",
					);
					await store.markTerminated(ref, { microvmId: row.microvmId });
					return "gone";
				}
				logger.warn(
					{ ...ref, microvmId: row.microvmId, state, err: error },
					"nudge failed; the queued Turn waits for the In-VM server",
				);
				return "nudged";
			}
		}

		async function ensure(ref: ConversationRef, rehydrated: boolean) {
			const claim = await store.claimLaunch(ref, {
				staleLaunchAfterMs: STALE_LAUNCH_MS,
			});
			if (claim === "claimed") return launch(ref);
			// `terminated` can only be seen here if the row changed between the
			// claim and the read (another caller's launch just failed and released
			// it): claim again, once.
			if (claim.state === "terminated") {
				if (!rehydrated) return ensure(ref, true);
				return;
			}
			// Another caller holds a fresh `launching` claim: its VM's boot drains
			// the queue, this Turn included.
			if (claim.state !== "running" || !claim.microvmId || !claim.endpoint) {
				return;
			}
			if (deps.upgradeUrgent) {
				const current = await controlPlane.latestImageVersion();
				if (current !== undefined && claim.imageVersion !== current) {
					if (
						!(await store.claimUpgrade(ref, { microvmId: claim.microvmId }))
					) {
						return; // someone else is upgrading it
					}
					// Terminate rather than let the stale snapshot auto-resume; a
					// failure here leaves an orphan the idle policy winds down.
					await controlPlane.terminate(claim.microvmId).catch((error) => {
						logger.warn(
							{ ...ref, microvmId: claim.microvmId, err: error },
							"terminate of the stale VM failed; launching anyway",
						);
					});
					return launch(ref);
				}
			}
			const outcome = await nudge(ref, {
				microvmId: claim.microvmId,
				endpoint: claim.endpoint,
			});
			// One lazy rehydrate per POST: the re-claim launches onto the current
			// image, and the freshly queued Turn runs at the new VM's boot.
			if (outcome === "gone" && !rehydrated) return ensure(ref, true);
		}

		return ensure(ref, false);
	};
}
