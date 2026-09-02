import { describe, expect, it } from "bun:test";
import {
	CreateMicrovmAuthTokenCommand,
	GetMicrovmCommand,
	ResourceNotFoundException,
	RunMicrovmCommand,
} from "@aws-sdk/client-lambda-microvms";
import {
	createLambdaMicrovmControlPlane,
	MICROVM_IDLE_POLICY,
	MICROVM_MAXIMUM_DURATION_SECONDS,
} from "./microvm-control-plane";

const config = {
	region: "us-west-2",
	imageArn: "arn:aws:lambda:us-west-2:123:microvm-image:img",
	egressConnectorArn: "arn:aws:lambda:us-west-2:123:network-connector:egress",
	executionRoleArn: "arn:aws:iam::123:role/exec",
};

function planeWith(send: (command: unknown) => Promise<unknown>) {
	const sent: unknown[] = [];
	const plane = createLambdaMicrovmControlPlane(config, {
		send: (async (command: unknown) => {
			sent.push(command);
			return send(command);
		}) as never,
	});
	return { plane, sent };
}

describe("Lambda MicroVM control plane", () => {
	it("launches with the spec's lifecycle parameters, both connectors, and the payload", async () => {
		const { plane, sent } = planeWith(async () => ({
			microvmId: "microvm-1",
			endpoint: "vm.example",
			imageVersion: "4",
		}));

		const vm = await plane.run({ runHookPayload: '{"A":"b"}' });

		expect(vm).toEqual({
			microvmId: "microvm-1",
			endpoint: "vm.example",
			imageVersion: "4",
		});
		const command = sent[0] as RunMicrovmCommand;
		expect(command).toBeInstanceOf(RunMicrovmCommand);
		expect(command.input).toEqual({
			imageIdentifier: config.imageArn,
			ingressNetworkConnectors: [
				"arn:aws:lambda:us-west-2:aws:network-connector:aws-network-connector:ALL_INGRESS",
			],
			egressNetworkConnectors: [config.egressConnectorArn],
			executionRoleArn: config.executionRoleArn,
			runHookPayload: '{"A":"b"}',
			idlePolicy: {
				maxIdleDurationSeconds: 900,
				suspendedDurationSeconds: 3600,
				autoResumeEnabled: true,
			},
			maximumDurationInSeconds: 28_800,
		});
		expect(MICROVM_IDLE_POLICY.autoResumeEnabled).toBe(true);
		expect(MICROVM_MAXIMUM_DURATION_SECONDS).toBe(8 * 3600);
	});

	it("mints a short-lived token scoped to the In-VM server port and returns the proxy header value", async () => {
		const { plane, sent } = planeWith(async () => ({
			authToken: { "X-aws-proxy-auth": "jwe-token" },
		}));

		expect(await plane.createAuthToken("microvm-1")).toBe("jwe-token");
		const command = sent[0] as CreateMicrovmAuthTokenCommand;
		expect(command).toBeInstanceOf(CreateMicrovmAuthTokenCommand);
		expect(command.input).toEqual({
			microvmIdentifier: "microvm-1",
			expirationInMinutes: 5,
			allowedPorts: [{ port: 8080 }],
		});
	});

	it("reports a forgotten VM as not-found and passes other states through", async () => {
		const gone = planeWith(async () => {
			throw new ResourceNotFoundException({
				message: "no such microvm",
				$metadata: {},
			});
		});
		expect(await gone.plane.getState("microvm-x")).toBe("not-found");
		expect(gone.sent[0]).toBeInstanceOf(GetMicrovmCommand);

		const suspended = planeWith(async () => ({ state: "SUSPENDED" }));
		expect(await suspended.plane.getState("microvm-1")).toBe("SUSPENDED");
	});
});
