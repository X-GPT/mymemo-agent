import type { Logger } from "pino";
import type { MicrovmConfig } from "@/config/env";
import type { ConversationRef } from "@/features/conversation-store/conversation-store";
import { mintGatewayToken } from "@/features/gateway/gateway-token";
import type { ConversationVmStore } from "./conversation-vm-store";
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
	constructor(cause: unknown) {
		super("MicroVM launch failed", { cause });
		this.name = "VmUnavailableError";
	}
}

const NUDGE_TIMEOUT_MS = 10_000;

export interface EnsureVmDeps {
	store: ConversationVmStore;
	controlPlane: MicrovmControlPlane;
	/**
	 * The MicroVM config plus the two data-plane URLs the `runHookPayload`
	 * carries into the trusted in-VM process (ADR-0034).
	 */
	config: MicrovmConfig & { agentDatabaseUrl: string; redisUrl: string };
	fetch?: typeof fetch;
}

export function createEnsureVm({
	store,
	controlPlane,
	config,
	fetch = globalThis.fetch,
}: EnsureVmDeps): EnsureVm {
	return (ref, logger) => {
		/** This caller owns the `launching` claim: mint, launch, record. */
		async function launch(): Promise<void> {
			const gatewayToken = await mintGatewayToken({
				conversationId: ref.conversationId,
				secret: config.gatewayTokenSecret,
			});
			// The platform caps the payload at 4 KB; its own validation rejects
			// an oversize one into the catch below.
			const vm = await controlPlane
				.run({
					runHookPayload: JSON.stringify({
						MYMEMO_USER_ID: ref.userId,
						MYMEMO_CONVERSATION_ID: ref.conversationId,
						AGENT_DATABASE_URL: config.agentDatabaseUrl,
						KB_DATABASE_URL: config.kbDatabaseUrl,
						REDIS_URL: config.redisUrl,
						MODEL_BASE_URL: `${config.gatewayBaseUrl}/v2/gateway/${ref.conversationId}`,
						MODEL_API_KEY: gatewayToken,
						MODEL: config.model,
					}),
				})
				.catch(async (error) => {
					// Hand the claim back now rather than after the stale window, so
					// the client's retry can launch immediately. A RunMicrovm that
					// succeeded on the platform but failed to answer leaves an orphan
					// the idle policy winds down — accepted; the orphan sweeper is
					// deferred.
					await store.releaseClaim(ref).catch((releaseError) => {
						logger.error(
							{ ...ref, err: releaseError },
							"VM claim release failed",
						);
					});
					logger.error(
						{ ...ref, err: error },
						"RunMicrovm failed after retries",
					);
					throw new VmUnavailableError(error);
				});
			await store.recordLaunched(ref, vm);
			logger.info({ ...ref, ...vm }, "MicroVM launched");
			// No nudge: the In-VM server's drain loop starts inside the /run hook and
			// consumes the queue itself, and the platform holds endpoint traffic
			// until that hook returns.
		}

		/** Nudge a `running` VM; a suspended one auto-resumes under the platform. */
		async function nudge(
			microvmId: string,
			endpoint: string,
		): Promise<"nudged" | "gone"> {
			try {
				// ponytail: one token mint per nudge; cache per VM if the control-plane
				// call rate ever matters.
				const token = await controlPlane.createAuthToken(microvmId);
				const response = await fetch(`https://${endpoint}/nudge`, {
					method: "POST",
					headers: {
						"x-aws-proxy-auth": token,
						"x-aws-proxy-port": String(IN_VM_SERVER_PORT),
					},
					signal: AbortSignal.timeout(NUDGE_TIMEOUT_MS),
				});
				if (!response.ok) throw new Error(`nudge answered ${response.status}`);
				return "nudged";
			} catch (error) {
				// Reactive at-cap handling: the platform may have ended the VM (8 h
				// cap, a failed boot). Only its own word marks the row terminated —
				// a booting or suspending VM keeps its row, and its interval
				// self-heal drains the queue without this nudge.
				const state = await controlPlane
					.getState(microvmId)
					.catch(() => "unknown" as const);
				if (["TERMINATED", "TERMINATING", "not-found"].includes(state)) {
					logger.warn(
						{ ...ref, microvmId, state },
						"MicroVM gone; rehydrating on the next claim",
					);
					await store.markTerminated(ref, { microvmId });
					return "gone";
				}
				logger.warn(
					{ ...ref, microvmId, state, err: error },
					"nudge failed; the queued Turn waits for the In-VM server",
				);
				return "nudged";
			}
		}

		async function ensure(rehydrated: boolean) {
			const claim = await store.claimLaunch(ref);
			if (claim === "claimed") return launch();
			// Another caller holds a fresh `launching` claim: its VM's boot drains
			// the queue, this Turn included. (`terminated` here means that launch
			// just failed between the claim and the read; the client's idempotent
			// re-POST rehydrates.)
			if (claim.state !== "running" || !claim.microvmId || !claim.endpoint) {
				return;
			}
			if (config.upgradeUrgent) {
				const current = await controlPlane.latestImageVersion();
				if (current !== undefined && claim.imageVersion !== current) {
					// Terminate rather than let the stale snapshot auto-resume (a
					// repeat on an already-retiring VM is idempotent; a failure leaves
					// an orphan the idle policy winds down), retire the row — guarded
					// on this VM id — and rehydrate: the re-claim hands the launch to
					// exactly one caller.
					await controlPlane.terminate(claim.microvmId).catch((error) => {
						logger.warn(
							{ ...ref, microvmId: claim.microvmId, err: error },
							"terminate of the stale VM failed; rehydrating anyway",
						);
					});
					await store.markTerminated(ref, { microvmId: claim.microvmId });
					return ensure(true);
				}
			}
			const outcome = await nudge(claim.microvmId, claim.endpoint);
			// One lazy rehydrate per POST: the re-claim launches onto the current
			// image, and the freshly queued Turn runs at the new VM's boot.
			if (outcome === "gone" && !rehydrated) return ensure(true);
		}

		return ensure(false);
	};
}
