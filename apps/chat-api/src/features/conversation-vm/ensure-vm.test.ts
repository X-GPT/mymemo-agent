import { describe, expect, it } from "bun:test";
import { verifyGatewayToken } from "@/features/gateway/gateway-token";
import type {
	ConversationRef,
	ConversationVmRow,
	ConversationVmStore,
} from "./conversation-vm-store";
import {
	createEnsureVm,
	type EnsureVmDeps,
	VmUnavailableError,
} from "./ensure-vm";
import type { MicrovmControlPlane } from "./microvm-control-plane";

const ref: ConversationRef = { userId: "member-1", conversationId: "conv-1" };
const SECRET = "gateway-signing-secret";

/**
 * An in-memory `conversation_vm` row with the store's state transitions
 * (the stale-claim window is the SQL's business, covered by the store tests).
 */
class FakeVmStore implements ConversationVmStore {
	row: ConversationVmRow | null = null;
	readonly calls: string[] = [];

	async claimLaunch() {
		this.calls.push("claimLaunch");
		if (!this.row || this.row.state === "terminated") {
			this.row = {
				microvmId: null,
				endpoint: null,
				imageVersion: null,
				state: "launching",
			};
			return "claimed" as const;
		}
		return { ...this.row };
	}

	async recordLaunched(
		_ref: ConversationRef,
		vm: { microvmId: string; endpoint: string; imageVersion: string },
	) {
		this.calls.push("recordLaunched");
		if (!this.row) throw new Error("no claim");
		this.row = { ...this.row, ...vm, state: "running" };
	}

	async releaseClaim() {
		this.calls.push("releaseClaim");
		if (this.row) this.row = { ...this.row, state: "terminated" };
	}

	async markTerminated(_ref: ConversationRef, options: { microvmId: string }) {
		this.calls.push("markTerminated");
		if (this.row?.microvmId === options.microvmId) {
			this.row = { ...this.row, state: "terminated" };
		}
	}
}

function fakeControlPlane(
	overrides: Partial<MicrovmControlPlane> & { state?: string } = {},
) {
	const runs: string[] = [];
	const terminated: string[] = [];
	const plane: MicrovmControlPlane & {
		runs: string[];
		terminated: string[];
	} = {
		runs,
		terminated,
		async run({ runHookPayload }) {
			runs.push(runHookPayload);
			return {
				microvmId: `microvm-${runs.length}`,
				endpoint: `vm-${runs.length}.example`,
				imageVersion: "7",
			};
		},
		async getState() {
			return (overrides.state ?? "RUNNING") as "RUNNING";
		},
		async createAuthToken(microvmId) {
			return `token-for-${microvmId}`;
		},
		async terminate(microvmId) {
			terminated.push(microvmId);
		},
		async latestImageVersion() {
			return "7";
		},
		...overrides,
	};
	return plane;
}

function fakeFetch(status = 202) {
	const requests: Array<{ url: string; headers: Record<string, string> }> = [];
	const fetchImpl = (async (
		url: string | URL | Request,
		init?: RequestInit,
	) => {
		requests.push({
			url: String(url),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		});
		if (status === 0) throw new Error("connection refused");
		return new Response(null, { status });
	}) as typeof fetch;
	return { requests, fetch: fetchImpl };
}

function ensureWith(
	overrides: Partial<EnsureVmDeps> & {
		store?: FakeVmStore;
		urgent?: boolean;
	} = {},
) {
	const store = overrides.store ?? new FakeVmStore();
	const controlPlane = (overrides.controlPlane ??
		fakeControlPlane()) as ReturnType<typeof fakeControlPlane>;
	const net = fakeFetch();
	const ensure = createEnsureVm({
		store,
		controlPlane,
		config: {
			imageArn: "arn:image",
			egressConnectorArn: "arn:egress",
			executionRoleArn: "arn:role",
			agentDatabaseUrl: "postgresql://agent:pw@db.internal/mymemo_agent",
			kbDatabaseUrl: "postgresql://kb:pw@db.internal/mymemo_kb",
			redisUrl: "rediss://:pw@redis.internal:6379",
			gatewayBaseUrl: "http://alb.internal",
			model: "anthropic/claude-sonnet-5",
			upgradeUrgent: overrides.urgent ?? false,
		},
		gatewayTokenSecret: SECRET,
		fetch: net.fetch,
		...overrides,
	});
	const ensureVm = (r: ConversationRef) =>
		ensure(r, { info() {}, warn() {}, error() {} });
	return { ensureVm, store, controlPlane, net };
}

describe("Ensure-VM (#669)", () => {
	it("cold-launches for a VM-less Conversation with a complete runHookPayload and a valid gateway token, then records the VM without nudging", async () => {
		const { ensureVm, store, controlPlane, net } = ensureWith();

		await ensureVm(ref);

		expect(controlPlane.runs).toHaveLength(1);
		const payload = JSON.parse(controlPlane.runs[0] ?? "{}");
		expect(payload).toMatchObject({
			MYMEMO_USER_ID: "member-1",
			MYMEMO_CONVERSATION_ID: "conv-1",
			AGENT_DATABASE_URL: "postgresql://agent:pw@db.internal/mymemo_agent",
			KB_DATABASE_URL: "postgresql://kb:pw@db.internal/mymemo_kb",
			REDIS_URL: "rediss://:pw@redis.internal:6379",
			MODEL_BASE_URL: "http://alb.internal/v2/gateway/conv-1",
			MODEL: "anthropic/claude-sonnet-5",
		});
		expect(
			await verifyGatewayToken(payload.MODEL_API_KEY, {
				secret: SECRET,
				conversationId: "conv-1",
			}),
		).toEqual({ ok: true });
		expect(store.row).toMatchObject({
			state: "running",
			microvmId: "microvm-1",
			endpoint: "vm-1.example",
			imageVersion: "7",
		});
		// The boot's drain loop serves the queue; no nudge to a booting VM.
		expect(net.requests).toHaveLength(0);
		expect(store.calls).toEqual(["claimLaunch", "recordLaunched"]);
	});

	it("nudges a running VM through its endpoint with a freshly minted per-VM token", async () => {
		const { ensureVm, store, controlPlane, net } = ensureWith();
		await ensureVm(ref);
		store.calls.length = 0;

		await ensureVm(ref);

		expect(controlPlane.runs).toHaveLength(1);
		expect(net.requests).toEqual([
			{
				url: "https://vm-1.example/nudge",
				headers: {
					"x-aws-proxy-auth": "token-for-microvm-1",
					"x-aws-proxy-port": "8080",
				},
			},
		]);
		expect(store.calls).toEqual(["claimLaunch"]);
	});

	it("releases the claim and surfaces a retryable error when the launch fails after retries", async () => {
		const controlPlane = fakeControlPlane({
			async run() {
				throw new Error("502 from the platform, retries exhausted");
			},
		});
		const { ensureVm, store } = ensureWith({ controlPlane });

		await expect(ensureVm(ref)).rejects.toBeInstanceOf(VmUnavailableError);
		expect(store.row?.state).toBe("terminated");
		expect(store.calls).toEqual(["claimLaunch", "releaseClaim"]);

		// The very next POST launches again — no stale window to wait out.
		const again = ensureWith({ store });
		await again.ensureVm(ref);
		expect(store.row?.state).toBe("running");
	});

	it("does nothing while another caller's fresh launching claim is in flight", async () => {
		const store = new FakeVmStore();
		store.row = {
			microvmId: null,
			endpoint: null,
			imageVersion: null,
			state: "launching",
		};
		const { ensureVm, controlPlane, net } = ensureWith({ store });

		await ensureVm(ref);

		expect(controlPlane.runs).toHaveLength(0);
		expect(net.requests).toHaveLength(0);
	});

	it("rehydrates lazily when a nudge fails and the platform says the VM is gone", async () => {
		const controlPlane = fakeControlPlane({ state: "TERMINATED" });
		const { ensureVm, store } = ensureWith({ controlPlane });
		await ensureVm(ref);
		const before = store.row?.microvmId;
		const failing = ensureWith({
			store,
			controlPlane,
			fetch: fakeFetch(0).fetch,
		});

		await failing.ensureVm(ref);

		expect(controlPlane.runs).toHaveLength(2);
		expect(store.row).toMatchObject({
			state: "running",
			microvmId: "microvm-2",
		});
		expect(store.row?.microvmId).not.toBe(before);
		expect(store.calls).toEqual([
			"claimLaunch",
			"recordLaunched",
			"claimLaunch",
			"markTerminated",
			"claimLaunch",
			"recordLaunched",
		]);
	});

	it("keeps the row when a nudge fails but the platform still reports the VM (booting, suspending)", async () => {
		const controlPlane = fakeControlPlane({ state: "PENDING" });
		const { ensureVm, store } = ensureWith({ controlPlane });
		await ensureVm(ref);
		const failing = ensureWith({
			store,
			controlPlane,
			fetch: fakeFetch(503).fetch,
		});

		await failing.ensureVm(ref);

		expect(controlPlane.runs).toHaveLength(1);
		expect(store.row).toMatchObject({
			state: "running",
			microvmId: "microvm-1",
		});
	});

	it("with the urgent flag, a stale-image VM is terminated and rehydrated instead of nudged", async () => {
		const controlPlane = fakeControlPlane({
			async latestImageVersion() {
				return "8";
			},
		});
		const { ensureVm, store, net } = ensureWith({
			controlPlane,
			urgent: true,
		});
		await ensureVm(ref); // launches on "7" (the fake's RunMicrovm answer)
		store.calls.length = 0;

		await ensureVm(ref);

		expect(controlPlane.terminated).toEqual(["microvm-1"]);
		expect(controlPlane.runs).toHaveLength(2);
		expect(store.row).toMatchObject({
			state: "running",
			microvmId: "microvm-2",
		});
		expect(store.calls).toEqual([
			"claimLaunch",
			"markTerminated",
			"claimLaunch",
			"recordLaunched",
		]);
		expect(net.requests).toHaveLength(0);
	});

	it("with the urgent flag, a current-image VM is simply nudged", async () => {
		const { ensureVm, controlPlane, net } = ensureWith({ urgent: true });
		await ensureVm(ref);

		await ensureVm(ref);

		expect(controlPlane.terminated).toEqual([]);
		expect(controlPlane.runs).toHaveLength(1);
		expect(net.requests).toHaveLength(1);
	});
});
