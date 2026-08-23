import { describe, expect, it } from "bun:test";
import type { RuntimeLogger } from "../logger";
import {
	createE2bSandboxProvisioner,
	createSandboxProvisioner,
	type E2bSandboxFactory,
	type ProvisionerSandbox,
	SANDBOX_WORKSPACE_ROOT,
	type SandboxProvisionerDeps,
} from "./sandbox-provisioner";

function makeFakeSandbox(sandboxId: string): {
	sandbox: ProvisionerSandbox;
	setTimeoutCalls: number[];
} {
	const setTimeoutCalls: number[] = [];
	return {
		setTimeoutCalls,
		sandbox: {
			sandboxId,
			setTimeout: async (timeoutMs: number) => {
				setTimeoutCalls.push(timeoutMs);
			},
			commands: {
				run: async () => {
					throw new Error("unexpected command");
				},
			},
			files: {
				read: async () => {
					throw new Error("unexpected read");
				},
				write: async () => {
					throw new Error("unexpected write");
				},
			},
		},
	};
}

function makeLogger(): {
	logger: RuntimeLogger;
	warns: Record<string, unknown>[];
} {
	const warns: Record<string, unknown>[] = [];
	return {
		warns,
		logger: {
			info: () => {},
			warn: (obj) => {
				warns.push(obj);
			},
			error: () => {},
		},
	};
}

function makeDeps(overrides?: Partial<SandboxProvisionerDeps>): {
	deps: SandboxProvisionerDeps;
	connected: ReturnType<typeof makeFakeSandbox>;
	created: ReturnType<typeof makeFakeSandbox>;
	connectCalls: string[];
	createCalls: { userId: string; conversationId: string }[];
	warns: Record<string, unknown>[];
} {
	const connected = makeFakeSandbox("sbx-connected");
	const created = makeFakeSandbox("sbx-created");
	const connectCalls: string[] = [];
	const createCalls: { userId: string; conversationId: string }[] = [];
	const { logger, warns } = makeLogger();
	return {
		connected,
		created,
		connectCalls,
		createCalls,
		warns,
		deps: {
			sandboxIdleMs: 300_000,
			logger,
			connectSandbox: async (sandboxId) => {
				connectCalls.push(sandboxId);
				return connected.sandbox;
			},
			createSandbox: async (input) => {
				createCalls.push(input);
				return created.sandbox;
			},
			...overrides,
		},
	};
}

const input = {
	userId: "user-1",
	conversationId: "conv-1",
	sandboxId: "sbx-existing" as string | null,
	sandboxTainted: false,
};

describe("createSandboxProvisioner", () => {
	it("passes only E2B config and owner metadata across the production SDK boundary", async () => {
		const created = makeFakeSandbox("sbx-created");
		const createCalls: Parameters<E2bSandboxFactory["create"]>[] = [];
		const factory: E2bSandboxFactory = {
			async connect() {
				throw new Error("unexpected connect");
			},
			async create(...args) {
				createCalls.push(args);
				return created.sandbox;
			},
		};
		const trustedOnlyEnvironment = {
			AWS_ACCESS_KEY_ID: "artifact-aws-access-key",
			AWS_SECRET_ACCESS_KEY: "artifact-aws-secret-key",
			AWS_SESSION_TOKEN: "artifact-aws-session-token",
			ARTIFACT_BUCKET: "artifact-private-bucket",
			AWS_REGION: "artifact-private-region",
			ARTIFACT_PRESIGNED_URL:
				"https://objects.example/private?X-Amz-Signature=artifact-secret",
		};
		const previousEnvironment = Object.fromEntries(
			Object.keys(trustedOnlyEnvironment).map((key) => [key, process.env[key]]),
		);
		Object.assign(process.env, trustedOnlyEnvironment);

		try {
			const { logger } = makeLogger();
			const provisioner = createE2bSandboxProvisioner(
				{
					apiKey: "e2b-only-key",
					template: "artifact-test-template",
					sandboxIdleMs: 300_000,
					logger,
				},
				factory,
			);

			await provisioner.provisionForRun({ ...input, sandboxId: null });

			expect(createCalls).toEqual([
				[
					"artifact-test-template",
					{
						apiKey: "e2b-only-key",
						timeoutMs: 300_000,
						lifecycle: { onTimeout: "pause" },
						metadata: {
							userId: "user-1",
							conversationId: "conv-1",
						},
					},
				],
			]);
			const serializedBoundary = JSON.stringify(createCalls);
			for (const trustedOnlyValue of Object.values(trustedOnlyEnvironment)) {
				expect(serializedBoundary).not.toContain(trustedOnlyValue);
			}
		} finally {
			for (const [key, value] of Object.entries(previousEnvironment)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("connects to the conversation's sandbox when the pointer is set and not tainted", async () => {
		const { deps, connectCalls, createCalls } = makeDeps();
		const provisioner = createSandboxProvisioner(deps);

		const provisioned = await provisioner.provisionForRun(input);

		expect(connectCalls).toEqual(["sbx-existing"]);
		expect(createCalls).toEqual([]);
		expect(provisioned.sandboxId).toBe("sbx-connected");
		expect(provisioned.isNew).toBe(false);
		expect(provisioned.workspaceRoot).toBe(SANDBOX_WORKSPACE_ROOT);
		expect(provisioned.commandClient).toBeDefined();
		expect(provisioned.fileClient).toBeDefined();
		expect(provisioned.artifactWorkspace).toBeDefined();
	});

	it("creates a fresh sandbox when the conversation has none", async () => {
		const { deps, connectCalls, createCalls } = makeDeps();
		const provisioner = createSandboxProvisioner(deps);

		const provisioned = await provisioner.provisionForRun({
			...input,
			sandboxId: null,
		});

		expect(connectCalls).toEqual([]);
		expect(createCalls).toEqual([
			{ userId: "user-1", conversationId: "conv-1" },
		]);
		expect(provisioned.sandboxId).toBe("sbx-created");
		expect(provisioned.isNew).toBe(true);
	});

	it("never reuses a tainted sandbox: goes straight to a fresh one", async () => {
		const { deps, connectCalls, createCalls } = makeDeps();
		const provisioner = createSandboxProvisioner(deps);

		const provisioned = await provisioner.provisionForRun({
			...input,
			sandboxTainted: true,
		});

		expect(connectCalls).toEqual([]);
		expect(createCalls).toHaveLength(1);
		expect(provisioned.isNew).toBe(true);
	});

	it("falls back to a fresh sandbox when connect fails, logging the reason", async () => {
		const { deps, createCalls, warns } = makeDeps({
			connectSandbox: async () => {
				throw new Error("sandbox was killed");
			},
		});
		const provisioner = createSandboxProvisioner(deps);

		const provisioned = await provisioner.provisionForRun(input);

		expect(createCalls).toHaveLength(1);
		expect(provisioned.sandboxId).toBe("sbx-created");
		expect(provisioned.isNew).toBe(true);
		expect(warns).toHaveLength(1);
		expect(warns[0]).toMatchObject({
			sandboxId: "sbx-existing",
			conversationId: "conv-1",
			error: "sandbox was killed",
		});
	});

	it("propagates a create failure", async () => {
		const { deps } = makeDeps({
			createSandbox: async () => {
				throw new Error("template not found");
			},
		});
		const provisioner = createSandboxProvisioner(deps);

		await expect(
			provisioner.provisionForRun({ ...input, sandboxId: null }),
		).rejects.toThrow("template not found");
	});

	it("renew extends the sandbox's idle window", async () => {
		const { deps, connected } = makeDeps();
		const provisioner = createSandboxProvisioner(deps);
		const provisioned = await provisioner.provisionForRun(input);

		await provisioned.renew();
		await provisioned.renew();

		expect(connected.setTimeoutCalls).toEqual([300_000, 300_000]);
	});

	it("dispose stops renewal and never kills the live workspace", async () => {
		const { deps, created } = makeDeps();
		const provisioner = createSandboxProvisioner(deps);
		const provisioned = await provisioner.provisionForRun({
			...input,
			sandboxId: null,
		});
		await provisioned.renew();

		provisioned.dispose();
		provisioned.dispose(); // idempotent
		await provisioned.renew(); // a racing timer tick after dispose is inert

		// The only sandbox call ever made is the pre-dispose renewal — the handle
		// exposes no kill, so the workspace idle-pauses instead of dying.
		expect(created.setTimeoutCalls).toEqual([300_000]);
	});
});
