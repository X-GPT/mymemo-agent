import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LeaseRecord, LeaseRef, LeaseStore } from "@/features/lease-store";
import type { RequestLogger } from "@/features/streaming/logger";
import { ConversationBusyError, SandboxCreationError } from "./errors";
import {
	DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
	SandboxLeaseManager,
} from "./sandbox-lease-manager";

const silentLogger = {
	info: () => {},
	error: () => {},
	warn: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as RequestLogger;

/** In-memory {@link LeaseStore} keyed exactly like the Postgres composite PK. */
class FakeLeaseStore implements LeaseStore {
	readonly records = new Map<string, LeaseRecord>();
	/** Every upsert, in order — stands in for the row's `updated_at` bumps. */
	readonly upserts: LeaseRecord[] = [];
	private key(ref: LeaseRef) {
		return `${ref.userId}\0${ref.conversationId}`;
	}
	async get(ref: LeaseRef) {
		return this.records.get(this.key(ref)) ?? null;
	}
	async upsert(record: LeaseRecord) {
		this.records.set(this.key(record), { ...record });
		this.upserts.push({ ...record });
	}
	async delete(ref: LeaseRef) {
		this.records.delete(this.key(ref));
	}
	/** Keys with a claim currently held — stands in for the cross-process lock. */
	readonly heldClaims = new Set<string>();
	/** Simulate another replica/turn already holding the conversation's claim. */
	holdClaim(ref: LeaseRef) {
		this.heldClaims.add(this.key(ref));
	}
	async withClaim<T>(ref: LeaseRef, fn: () => Promise<T>) {
		const k = this.key(ref);
		if (this.heldClaims.has(k)) return { acquired: false };
		this.heldClaims.add(k);
		try {
			return { acquired: true, result: await fn() };
		} finally {
			this.heldClaims.delete(k);
		}
	}
}

function makeDeps() {
	let nextSandboxId = 1;
	const createSandbox = mock(async () => ({
		sandboxId: `sbx-${nextSandboxId++}`,
	}));
	const connectSandbox = mock(async (sandboxId: string) => ({ sandboxId }));
	const ensureSandboxDaemon = mock(async () => ({
		url: "http://daemon:8080",
		trafficAccessToken: "tok",
	}));
	// Pure compute from the handle — the endpoint is derived, never persisted.
	const daemonEndpoint = mock(() => ({
		url: "http://daemon:8080",
		trafficAccessToken: "tok",
	}));
	const killSandbox = mock(async () => undefined);
	const cancelSandbox = mock(async () => undefined);
	const setSandboxTimeout = mock(async () => undefined);
	const hydrate = mock(async () => undefined);
	const sync = mock(async () => undefined);
	const leaseStore = new FakeLeaseStore();

	const manager = new SandboxLeaseManager({
		sandboxProvider: {
			createSandbox,
			connectSandbox,
			daemonEndpoint,
			setSandboxTimeout,
			ensureSandboxDaemon,
			killSandbox,
			cancelSandbox,
			// biome-ignore lint/suspicious/noExplicitAny: partial provider mock for the lease seam.
		} as any,
		leaseStore,
		workspaceStore: {
			hydrateConversationWorkspace: hydrate,
			syncConversationWorkspace: sync,
			// biome-ignore lint/suspicious/noExplicitAny: only hydrate/sync are used.
		} as any,
	});

	return {
		manager,
		leaseStore,
		createSandbox,
		connectSandbox,
		ensureSandboxDaemon,
		killSandbox,
		setSandboxTimeout,
		hydrate,
		sync,
	};
}

const refA: LeaseRef = { userId: "user-1", conversationId: "conv-1" };

describe("SandboxLeaseManager", () => {
	let d: ReturnType<typeof makeDeps>;
	beforeEach(() => {
		d = makeDeps();
	});

	describe("fresh acquisition", () => {
		it("creates and hydrates a fresh sandbox, persisting the lease pointer", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);

			expect(lease.reused).toBe(false);
			expect(lease.sandbox.sandboxId).toBe("sbx-1");
			expect(lease.daemon).toEqual({
				url: "http://daemon:8080",
				trafficAccessToken: "tok",
			});
			expect(d.hydrate).toHaveBeenCalledWith(refA);
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
			// Only the sandbox id is persisted — the endpoint is recomputed on reuse.
			expect(await d.leaseStore.get(refA)).toMatchObject({
				sandboxId: "sbx-1",
			});
		});

		it("hydrates the durable workspace before creating the sandbox", async () => {
			const order: string[] = [];
			d.hydrate.mockImplementation(async () => {
				order.push("hydrate");
			});
			d.createSandbox.mockImplementation(async () => {
				order.push("create");
				return { sandboxId: "sbx-1" };
			});

			await d.manager.acquire(refA, silentLogger);

			expect(order).toEqual(["hydrate", "create"]);
		});

		it("tears the sandbox down if it cannot be made usable after create", async () => {
			// ensureSandboxDaemon throws after createSandbox succeeded: the created
			// sandbox must be killed, not leaked, and nothing persisted.
			d.ensureSandboxDaemon.mockImplementationOnce(async () => {
				throw new Error("daemon never came up");
			});

			await expect(d.manager.acquire(refA, silentLogger)).rejects.toThrow(
				"daemon never came up",
			);

			expect(d.killSandbox).toHaveBeenCalledTimes(1);
			expect(await d.leaseStore.get(refA)).toBeNull();
			// Guard freed, so the conversation is not wedged.
			const ok = await d.manager.acquire(refA, silentLogger);
			expect(ok.reused).toBe(false);
		});

		it("retries once on a transient SandboxCreationError", async () => {
			d.createSandbox
				.mockImplementationOnce(async () => {
					throw new SandboxCreationError("boom");
				})
				.mockImplementationOnce(async () => ({ sandboxId: "sbx-retry" }));

			const lease = await d.manager.acquire(refA, silentLogger);

			expect(d.createSandbox).toHaveBeenCalledTimes(2);
			expect(lease.sandbox.sandboxId).toBe("sbx-retry");
		});
	});

	describe("warm reuse", () => {
		it("reuses a healthy warm sandbox for the same user + conversation", async () => {
			const first = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(first, silentLogger);

			const second = await d.manager.acquire(refA, silentLogger);

			expect(second.reused).toBe(true);
			expect(second.sandbox.sandboxId).toBe("sbx-1");
			// Reuse reattaches by id and reaches the daemon via the persisted
			// endpoint — no new sandbox, no re-deploy.
			expect(d.connectSandbox).toHaveBeenCalledWith("sbx-1", expect.anything());
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
			expect(d.ensureSandboxDaemon).toHaveBeenCalledTimes(1);
			expect(second.daemon).toEqual({
				url: "http://daemon:8080",
				trafficAccessToken: "tok",
			});
		});

		it("re-persists the lease on reuse so the idle reaper sees fresh liveness", async () => {
			const first = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(first, silentLogger);
			const upsertsBefore = d.leaseStore.upserts.length;

			await d.manager.acquire(refA, silentLogger);

			// Reuse writes the row again (bumping updated_at), not just reads it.
			expect(d.leaseStore.upserts.length).toBe(upsertsBefore + 1);
		});

		it("recreates a fresh sandbox when the warm lease is stale (sandbox gone)", async () => {
			const first = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(first, silentLogger);
			d.connectSandbox.mockImplementationOnce(async () => {
				throw new Error("sandbox not found");
			});

			const second = await d.manager.acquire(refA, silentLogger);

			expect(second.reused).toBe(false);
			expect(second.sandbox.sandboxId).toBe("sbx-2");
			expect(d.createSandbox).toHaveBeenCalledTimes(2);
			// The fresh pointer supersedes the stale one.
			expect(await d.leaseStore.get(refA)).toMatchObject({
				sandboxId: "sbx-2",
			});
		});
	});

	describe("idle timeout (single clock)", () => {
		it("sets the sandbox timeout to the idle window on a fresh acquire", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);

			expect(d.setSandboxTimeout).toHaveBeenCalledWith(
				lease.sandbox,
				DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
				expect.anything(),
			);
		});

		it("resets the timeout on warm reuse so the new turn gets a full window", async () => {
			const first = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(first, silentLogger);
			d.setSandboxTimeout.mockClear();

			await d.manager.acquire(refA, silentLogger);

			expect(d.setSandboxTimeout).toHaveBeenCalledWith(
				{ sandboxId: "sbx-1" },
				DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
				expect.anything(),
			);
		});

		it("resets the idle countdown from turn end on release", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			d.setSandboxTimeout.mockClear();

			await d.manager.release(lease, silentLogger);

			expect(d.setSandboxTimeout).toHaveBeenCalledWith(
				lease.sandbox,
				DEFAULT_SANDBOX_IDLE_TIMEOUT_MS,
				expect.anything(),
			);
		});

		it("honors a custom idle window", async () => {
			const manager = new SandboxLeaseManager(
				{
					sandboxProvider: {
						createSandbox: d.createSandbox,
						connectSandbox: d.connectSandbox,
						daemonEndpoint: () => ({ url: "http://daemon:8080" }),
						setSandboxTimeout: d.setSandboxTimeout,
						ensureSandboxDaemon: d.ensureSandboxDaemon,
						killSandbox: d.killSandbox,
						cancelSandbox: async () => {},
						// biome-ignore lint/suspicious/noExplicitAny: partial provider mock.
					} as any,
					leaseStore: d.leaseStore,
					workspaceStore: {
						hydrateConversationWorkspace: d.hydrate,
						syncConversationWorkspace: d.sync,
						// biome-ignore lint/suspicious/noExplicitAny: only hydrate/sync used.
					} as any,
				},
				1_000,
			);

			await manager.acquire(refA, silentLogger);

			expect(d.setSandboxTimeout).toHaveBeenCalledWith(
				expect.anything(),
				1_000,
				expect.anything(),
			);
		});
	});

	describe("isolation", () => {
		it("never shares a sandbox across users", async () => {
			const a = await d.manager.acquire(
				{ userId: "user-1", conversationId: "conv-x" },
				silentLogger,
			);
			const b = await d.manager.acquire(
				{ userId: "user-2", conversationId: "conv-x" },
				silentLogger,
			);

			expect(a.sandbox.sandboxId).not.toBe(b.sandbox.sandboxId);
			expect(b.reused).toBe(false);
			expect(d.createSandbox).toHaveBeenCalledTimes(2);
		});

		it("never shares a sandbox across conversations of one user", async () => {
			const a = await d.manager.acquire(
				{ userId: "user-1", conversationId: "conv-1" },
				silentLogger,
			);
			const b = await d.manager.acquire(
				{ userId: "user-1", conversationId: "conv-2" },
				silentLogger,
			);

			expect(a.sandbox.sandboxId).not.toBe(b.sandbox.sandboxId);
			expect(b.reused).toBe(false);
		});
	});

	describe("concurrency (reject policy)", () => {
		it("rejects a second turn while the first is in flight", async () => {
			const first = await d.manager.acquire(refA, silentLogger);

			await expect(
				d.manager.acquire(refA, silentLogger),
			).rejects.toBeInstanceOf(ConversationBusyError);
			// Only the first turn's sandbox was created.
			expect(d.createSandbox).toHaveBeenCalledTimes(1);

			// After release, the conversation is acquirable again (and warm-reused).
			await d.manager.release(first, silentLogger);
			const again = await d.manager.acquire(refA, silentLogger);
			expect(again.reused).toBe(true);
		});

		it("races: two simultaneous acquires yield exactly one busy rejection", async () => {
			const results = await Promise.allSettled([
				d.manager.acquire(refA, silentLogger),
				d.manager.acquire(refA, silentLogger),
			]);

			const fulfilled = results.filter((r) => r.status === "fulfilled");
			const rejected = results.filter((r) => r.status === "rejected");
			expect(fulfilled).toHaveLength(1);
			expect(rejected).toHaveLength(1);
			expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(
				ConversationBusyError,
			);
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
		});

		it("frees the in-flight guard when acquisition fails", async () => {
			d.createSandbox.mockImplementationOnce(async () => {
				throw new Error("hard failure");
			});

			await expect(d.manager.acquire(refA, silentLogger)).rejects.toThrow(
				"hard failure",
			);
			// Not wedged: a later acquire proceeds (fresh, since nothing persisted).
			const ok = await d.manager.acquire(refA, silentLogger);
			expect(ok.reused).toBe(false);
		});

		it("rejects as busy when another replica holds the conversation claim", async () => {
			// Simulate a different replica/process already inside the claim for this
			// conversation. The in-process guard can't see it; the cross-process
			// claim must.
			d.leaseStore.holdClaim(refA);

			await expect(
				d.manager.acquire(refA, silentLogger),
			).rejects.toBeInstanceOf(ConversationBusyError);
			// No sandbox was created behind the held claim.
			expect(d.createSandbox).not.toHaveBeenCalled();
			// Guard freed — once the other holder releases, this replica can acquire.
			d.leaseStore.heldClaims.delete(`${refA.userId}\0${refA.conversationId}`);
			const ok = await d.manager.acquire(refA, silentLogger);
			expect(ok.reused).toBe(false);
		});
	});

	describe("resume", () => {
		it("threads agentSessionId into a fresh sandbox and persists it", async () => {
			const lease = await d.manager.acquire(refA, silentLogger, {
				agentSessionId: "sess-1",
			});

			expect(lease.reused).toBe(false);
			expect(lease.agentSessionId).toBe("sess-1");
			expect(await d.leaseStore.get(refA)).toMatchObject({
				agentSessionId: "sess-1",
			});
		});

		it("resumes the recorded session when a stale lease is recreated", async () => {
			// Seed a persisted lease whose sandbox is gone.
			await d.leaseStore.upsert({
				...refA,
				sandboxId: "old",
				agentSessionId: "sess-resume",
			});
			d.connectSandbox.mockImplementationOnce(async () => {
				throw new Error("gone");
			});

			// The recreated sandbox should resume the conversation's recorded
			// session, not start blank.
			const lease = await d.manager.acquire(refA, silentLogger);
			expect(lease.reused).toBe(false);
			expect(lease.sandbox.sandboxId).toBe("sbx-1");
			expect(lease.agentSessionId).toBe("sess-resume");
			expect(await d.leaseStore.get(refA)).toMatchObject({
				agentSessionId: "sess-resume",
			});
		});

		it("carries the recorded agentSessionId forward on warm reuse", async () => {
			const first = await d.manager.acquire(refA, silentLogger, {
				agentSessionId: "sess-1",
			});
			await d.manager.release(first, silentLogger);

			const second = await d.manager.acquire(refA, silentLogger);
			expect(second.reused).toBe(true);
			expect(second.agentSessionId).toBe("sess-1");
		});

		it("honors an explicit null override to start a warm conversation fresh", async () => {
			const first = await d.manager.acquire(refA, silentLogger, {
				agentSessionId: "sess-1",
			});
			await d.manager.release(first, silentLogger);

			// Explicit null means "start fresh" — not "fall back to the recorded
			// session" — so the reused lease (and the persisted row) clear it.
			const second = await d.manager.acquire(refA, silentLogger, {
				agentSessionId: null,
			});
			expect(second.reused).toBe(true);
			expect(second.agentSessionId).toBeNull();
			expect(await d.leaseStore.get(refA)).toMatchObject({
				agentSessionId: null,
			});
		});
	});

	describe("release", () => {
		it("syncs the durable workspace and frees the guard", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(lease, silentLogger);

			expect(d.sync).toHaveBeenCalledWith(refA);
			// Still persisted (kept warm), and re-acquirable.
			expect(await d.leaseStore.get(refA)).not.toBeNull();
		});

		it("does not throw when the workspace sync fails", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			d.sync.mockImplementationOnce(async () => {
				throw new Error("store down");
			});

			await expect(
				d.manager.release(lease, silentLogger),
			).resolves.toBeUndefined();
		});

		it("frees the guard even if the idle-timeout reset throws", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			d.setSandboxTimeout.mockImplementationOnce(async () => {
				throw new Error("e2b control plane down");
			});

			await expect(
				d.manager.release(lease, silentLogger),
			).resolves.toBeUndefined();
			// Not wedged: the conversation is acquirable again.
			const again = await d.manager.acquire(refA, silentLogger);
			expect(again.reused).toBe(true);
		});

		it("holds the in-flight guard until the release sync completes", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			let finishSync: () => void = () => {};
			d.sync.mockImplementationOnce(
				() =>
					new Promise<undefined>((resolve) => {
						finishSync = () => resolve(undefined);
					}),
			);

			const releasing = d.manager.release(lease, silentLogger);
			// Sync is still in flight, so the next turn must not start against the
			// same workspace yet.
			await expect(
				d.manager.acquire(refA, silentLogger),
			).rejects.toBeInstanceOf(ConversationBusyError);

			finishSync();
			await releasing;
			// Once the sync settles the guard is freed and the conversation reuses.
			const again = await d.manager.acquire(refA, silentLogger);
			expect(again.reused).toBe(true);
		});
	});

	describe("terminate", () => {
		it("removes the pointer and kills the sandbox", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(lease, silentLogger);

			await d.manager.terminate(refA, silentLogger);

			expect(await d.leaseStore.get(refA)).toBeNull();
			expect(d.connectSandbox).toHaveBeenCalledWith("sbx-1", expect.anything());
			expect(d.killSandbox).toHaveBeenCalledTimes(1);
		});

		it("frees the in-flight guard so a terminated conversation is acquirable", async () => {
			// Acquire and do NOT release — the turn is still "in flight" when the
			// reaper terminates. The conversation must not be left wedged.
			await d.manager.acquire(refA, silentLogger);

			await d.manager.terminate(refA, silentLogger);

			const next = await d.manager.acquire(refA, silentLogger);
			expect(next.reused).toBe(false);
		});

		it("is a no-op for an unknown lease", async () => {
			await expect(
				d.manager.terminate(refA, silentLogger),
			).resolves.toBeUndefined();
			expect(d.killSandbox).not.toHaveBeenCalled();
		});

		it("still removes the pointer when the sandbox is already gone", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(lease, silentLogger);
			d.connectSandbox.mockImplementationOnce(async () => {
				throw new Error("gone");
			});

			await expect(
				d.manager.terminate(refA, silentLogger),
			).resolves.toBeUndefined();
			expect(await d.leaseStore.get(refA)).toBeNull();
		});
	});
});
