import {
	CreateMicrovmAuthTokenCommand,
	GetMicrovmCommand,
	GetMicrovmImageCommand,
	LambdaMicrovmsClient,
	type MicrovmState,
	ResourceNotFoundException,
	RunMicrovmCommand,
	TerminateMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import type { MicrovmConfig } from "@/config/env";

/**
 * chat-api's control-plane authority over per-Conversation MicroVMs (ADR-0034):
 * launch, observe, mint the per-VM endpoint token, terminate. Never the data
 * plane — the VM's execution role owns that. Suspend/Resume are deliberately
 * absent: the platform idle policy suspends, and a nudge through the endpoint
 * auto-resumes.
 */
export interface MicrovmControlPlane {
	/** `RunMicrovm` — the SDK retries the platform's transient 502s before this rejects. */
	run(input: {
		runHookPayload: string;
	}): Promise<{ microvmId: string; endpoint: string; imageVersion: string }>;
	/** The platform's view of the VM; `"not-found"` once the platform forgot it. */
	getState(microvmId: string): Promise<MicrovmState | "not-found">;
	/** A short-lived `X-aws-proxy-auth` value for the In-VM server's port. */
	createAuthToken(microvmId: string): Promise<string>;
	terminate(microvmId: string): Promise<void>;
	/** The image version a launch would run today (the urgent-upgrade check). */
	latestImageVersion(): Promise<string | undefined>;
}

type MicrovmLaunchConfig = Pick<
	MicrovmConfig,
	"imageArn" | "egressConnectorArn" | "executionRoleArn"
> & { region: string };

/** The port the image's In-VM server listens on. */
export const IN_VM_SERVER_PORT = 8080;

export function createLambdaMicrovmControlPlane(
	config: MicrovmLaunchConfig,
	client: Pick<LambdaMicrovmsClient, "send"> = new LambdaMicrovmsClient({
		region: config.region,
		// Adaptive retry absorbs RunMicrovm bursts against the 5 TPS quota and
		// the platform's transient 502s (seen live on #666/#667).
		retryMode: "adaptive",
		maxAttempts: 5,
	}),
): MicrovmControlPlane {
	// The platform's managed ingress connector: the JWE-authenticated endpoint.
	const ingressConnectorArn = `arn:aws:lambda:${config.region}:aws:network-connector:aws-network-connector:ALL_INGRESS`;
	return {
		async run({ runHookPayload }) {
			const vm = await client.send(
				new RunMicrovmCommand({
					imageIdentifier: config.imageArn,
					ingressNetworkConnectors: [ingressConnectorArn],
					egressNetworkConnectors: [config.egressConnectorArn],
					executionRoleArn: config.executionRoleArn,
					runHookPayload,
					// Lifecycle parameters (spec #654, lifetime resolution #650), fixed
					// in code rather than env so a deployment cannot silently weaken
					// them: suspend after 15 min idle, keep the snapshot an hour,
					// auto-resume on the next request; the platform enforces the 8 h
					// cap itself — an at-cap kill is handled reactively by the next
					// nudge, never tracked.
					idlePolicy: {
						maxIdleDurationSeconds: 900,
						suspendedDurationSeconds: 3600,
						autoResumeEnabled: true,
					},
					maximumDurationInSeconds: 28_800,
				}),
			);
			if (!vm.microvmId || !vm.endpoint || !vm.imageVersion) {
				throw new Error(
					"RunMicrovm answered without id, endpoint, or image version",
				);
			}
			return {
				microvmId: vm.microvmId,
				endpoint: vm.endpoint,
				imageVersion: vm.imageVersion,
			};
		},
		async getState(microvmId) {
			try {
				const vm = await client.send(
					new GetMicrovmCommand({ microvmIdentifier: microvmId }),
				);
				return vm.state ?? "not-found";
			} catch (error) {
				if (error instanceof ResourceNotFoundException) return "not-found";
				throw error;
			}
		},
		async createAuthToken(microvmId) {
			const minted = await client.send(
				new CreateMicrovmAuthTokenCommand({
					microvmIdentifier: microvmId,
					expirationInMinutes: 5, // every nudge mints its own token

					allowedPorts: [{ port: IN_VM_SERVER_PORT }],
				}),
			);
			const token = minted.authToken?.["X-aws-proxy-auth"];
			if (!token)
				throw new Error("CreateMicrovmAuthToken answered without a token");
			return token;
		},
		async terminate(microvmId) {
			await client.send(
				new TerminateMicrovmCommand({ microvmIdentifier: microvmId }),
			);
		},
		async latestImageVersion() {
			const image = await client.send(
				new GetMicrovmImageCommand({ imageIdentifier: config.imageArn }),
			);
			return image.latestActiveImageVersion;
		},
	};
}
