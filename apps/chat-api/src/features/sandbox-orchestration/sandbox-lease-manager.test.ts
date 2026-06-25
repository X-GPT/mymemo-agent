import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { LeaseRef, LeaseStore } from "@/features/lease-store";
import type { RequestLogger } from "@/features/streaming/logger";
import { ConversationBusyError, SandboxCreationError } from "./errors";
import { SandboxLeaseManager } from "./sandbox-lease-manager";

const silentLogger = {
	info: () => {},
	error: () => {},
	warn: () => {},
	debug: () => {},
	child: () => silentLogger,
} as unknown as RequestLogger;

/** A heartbeat interval far longer than any test, so it never fires mid-test
 * (except where a test sets its own short interval). */
const NO_HEARTBEAT = 1_000_000;
const OWNER = "owner-test";

interface Row {
	ownerId: string | null;
	fencingToken: number;
	expiresAt: number | null;
	sandboxId: string | null;
	agentSessionId: string | null;
}

/** In-memory {@link LeaseStore} mirroring the Postgres CAS semantics. */
class FakeLeaseStore implements LeaseStore {
	readonly rows = new Map<string, Row>();
	now = () => Date.now();
	key(ref: LeaseRef) {
		return `${ref.userId}\0${ref.conversationId}`;
	}
	async claimLease(ref: LeaseRef, ownerId: string, ttlMs: number) {
		const row = this.rows.get(this.key(ref));
		const free =
			!row ||
			row.ownerId === null ||
			(row.expiresAt !== null && row.expiresAt < this.now());
		if (row && !free) return null;
		const token = (row?.fencingToken ?? 0) + 1;
		const next: Row = {
			ownerId,
			fencingToken: token,
			expiresAt: this.now() + ttlMs,
			sandboxId: row?.sandboxId ?? null,
			agentSessionId: row?.agentSessionId ?? null,
		};
		this.rows.set(this.key(ref), next);
		return {
			fencingToken: token,
			sandboxId: next.sandboxId,
			agentSessionId: next.agentSessionId,
		};
	}
	async renewLease(
		ref: LeaseRef,
		ownerId: string,
		token: number,
		ttlMs: number,
	) {
		const row = this.rows.get(this.key(ref));
		if (!row || row.ownerId !== ownerId || row.fencingToken !== token)
			return false;
		row.expiresAt = this.now() + ttlMs;
		return true;
	}
	async releaseLease(
		ref: LeaseRef,
		ownerId: string,
		token: number,
		pointer: { sandboxId: string; agentSessionId: string | null },
	) {
		const row = this.rows.get(this.key(ref));
		if (!row || row.ownerId !== ownerId || row.fencingToken !== token) return;
		row.ownerId = null;
		row.expiresAt = null;
		row.sandboxId = pointer.sandboxId;
		row.agentSessionId = pointer.agentSessionId;
	}
	async dropLease(ref: LeaseRef, ownerId: string, token: number) {
		const row = this.rows.get(this.key(ref));
		if (!row || row.ownerId !== ownerId || row.fencingToken !== token) return;
		this.rows.delete(this.key(ref));
	}
	async get(ref: LeaseRef) {
		const row = this.rows.get(this.key(ref));
		return row
			? {
					userId: ref.userId,
					conversationId: ref.conversationId,
					sandboxId: row.sandboxId,
					agentSessionId: row.agentSessionId,
				}
			: null;
	}
	async delete(ref: LeaseRef) {
		this.rows.delete(this.key(ref));
	}
}

function makeDeps(heartbeatIntervalMs = NO_HEARTBEAT) {
	let nextSandboxId = 1;
	const createSandbox = mock(async () => ({ sandboxId: `sbx-${nextSandboxId++}` }));
	const connectSandbox = mock(async (sandboxId: string) => ({ sandboxId }));
	const ensureSandboxDaemon = mock(async () => ({
		url: "http://daemon:8080",
		trafficAccessToken: "tok",
	}));
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

	const manager = new SandboxLeaseManager(
		{
			sandboxProvider: {
				createSandbox,
				connectSandbox,
				daemonEndpoint,
				setSandboxTimeout,
				ensureSandboxDaemon,
				killSandbox,
				cancelSandbox,
				// biome-ignore lint/suspicious/noExplicitAny: partial provider mock.
			} as any,
			leaseStore,
			workspaceStore: {
				hydrateConversationWorkspace: hydrate,
				syncConversationWorkspace: sync,
				// biome-ignore lint/suspicious/noExplicitAny: only hydrate/sync used.
			} as any,
		},
		OWNER,
		{ heartbeatIntervalMs, leaseTtlMs: 30_000 },
	);

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

/** Seed a released warm lease (owner cleared, sandbox pointer present). */
function seedWarm(store: FakeLeaseStore, ref: LeaseRef, sandboxId: string) {
	store.rows.set(store.key(ref), {
		ownerId: null,
		fencingToken: 1,
		expiresAt: null,
		sandboxId,
		agentSessionId: null,
	});
}

describe("SandboxLeaseManager", () => {
	let d: ReturnType<typeof makeDeps>;
	beforeEach(() => {
		d = makeDeps();
	});

	describe("acquire", () => {
		it("claims, hydrates, and creates a fresh sandbox", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);

			expect(lease.reused).toBe(false);
			expect(lease.sandbox.sandboxId).toBe("sbx-1");
			expect(lease.fencingToken).toBe(1);
			expect(d.hydrate).toHaveBeenCalledWith(refA);
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
		});

		it("reuses the warm sandbox the lease points at", async () => {
			seedWarm(d.leaseStore, refA, "sbx-warm");

			const lease = await d.manager.acquire(refA, silentLogger);

			expect(lease.reused).toBe(true);
			expect(lease.sandbox.sandboxId).toBe("sbx-warm");
			expect(d.connectSandbox).toHaveBeenCalledWith("sbx-warm", expect.anything());
			expect(d.createSandbox).not.toHaveBeenCalled();
		});

		it("recreates when the warm sandbox is stale (connect fails)", async () => {
			seedWarm(d.leaseStore, refA, "sbx-dead");
			d.connectSandbox.mockImplementationOnce(async () => {
				throw new Error("gone");
			});

			const lease = await d.manager.acquire(refA, silentLogger);

			expect(lease.reused).toBe(false);
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
		});

		it("rejects a concurrent turn for the same conversation as busy", async () => {
			await d.manager.acquire(refA, silentLogger); // holds the lease, unreleased

			await expect(
				d.manager.acquire(refA, silentLogger),
			).rejects.toBeInstanceOf(ConversationBusyError);
			expect(d.createSandbox).toHaveBeenCalledTimes(1);
		});

		it("retries once on a transient SandboxCreationError", async () => {
			d.createSandbox
				.mockImplementationOnce(async () => {
					throw new SandboxCreationError("boom");
				})
				.mockImplementationOnce(async () => ({ sandboxId: "sbx-retry" }));

			const lease = await d.manager.acquire(refA, silentLogger);
			expect(lease.sandbox.sandboxId).toBe("sbx-retry");
		});

		it("tears the sandbox down and drops the lease if it can't be made usable", async () => {
			d.ensureSandboxDaemon.mockImplementationOnce(async () => {
				throw new Error("daemon never came up");
			});

			await expect(d.manager.acquire(refA, silentLogger)).rejects.toThrow(
				"daemon never came up",
			);

			expect(d.killSandbox).toHaveBeenCalledTimes(1);
			// Lease dropped → not wedged: a later acquire proceeds.
			expect(await d.leaseStore.get(refA)).toBeNull();
			const ok = await d.manager.acquire(refA, silentLogger);
			expect(ok.reused).toBe(false);
		});

		it("threads agentSessionId and carries the recorded session into reuse", async () => {
			const lease = await d.manager.acquire(refA, silentLogger, {
				agentSessionId: "sess-1",
			});
			expect(lease.agentSessionId).toBe("sess-1");

			await d.manager.release(lease, silentLogger, { ok: true });
			const second = await d.manager.acquire(refA, silentLogger);
			expect(second.agentSessionId).toBe("sess-1"); // recorded session reused
		});
	});

	describe("release", () => {
		it("on success keeps the sandbox warm, persists the pointer, and frees the lease", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);

			await d.manager.release(lease, silentLogger, { ok: true });

			expect(d.killSandbox).not.toHaveBeenCalled();
			expect(d.sync).toHaveBeenCalledWith(refA);
			expect(await d.leaseStore.get(refA)).toMatchObject({ sandboxId: "sbx-1" });
			// Freed → re-acquirable, and it reuses the warm sandbox.
			const again = await d.manager.acquire(refA, silentLogger);
			expect(again.reused).toBe(true);
		});

		it("on failure drops the lease and kills the sandbox", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);

			await d.manager.release(lease, silentLogger, { ok: false });

			expect(d.killSandbox).toHaveBeenCalledTimes(1);
			expect(await d.leaseStore.get(refA)).toBeNull();
			// Next turn creates fresh (no warm pointer left behind).
			const again = await d.manager.acquire(refA, silentLogger);
			expect(again.reused).toBe(false);
		});

		it("does not throw when cleanup fails", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			d.sync.mockImplementationOnce(async () => {
				throw new Error("store down");
			});
			await expect(
				d.manager.release(lease, silentLogger, { ok: true }),
			).resolves.toBeUndefined();
		});
	});

	describe("heartbeat", () => {
		it("aborts the turn when the lease is lost mid-turn", async () => {
			const dh = makeDeps(5); // 5ms heartbeat
			const lease = await dh.manager.acquire(refA, silentLogger);
			expect(lease.abortSignal.aborted).toBe(false);

			// Simulate the lease being stolen: bump the token so our renew no longer
			// matches → next beat returns false → onLost → abort.
			const row = dh.leaseStore.rows.get(dh.leaseStore.key(refA));
			if (row) row.fencingToken = 999;

			while (!lease.abortSignal.aborted) await Bun.sleep(3);
			expect(lease.abortSignal.aborted).toBe(true);
			lease.stopHeartbeat();
		});

		it("stops the heartbeat on release", async () => {
			const dh = makeDeps(5);
			const lease = await dh.manager.acquire(refA, silentLogger);
			await dh.manager.release(lease, silentLogger, { ok: true });
			dh.setSandboxTimeout.mockClear();
			dh.leaseStore.delete(refA); // a live heartbeat would now renew-fail/abort

			await Bun.sleep(20);
			expect(lease.abortSignal.aborted).toBe(false);
			expect(dh.setSandboxTimeout).not.toHaveBeenCalled();
		});
	});

	describe("terminate", () => {
		it("kills the sandbox and deletes the row", async () => {
			const lease = await d.manager.acquire(refA, silentLogger);
			await d.manager.release(lease, silentLogger, { ok: true });

			await d.manager.terminate(refA, silentLogger);

			expect(d.killSandbox).toHaveBeenCalledTimes(1);
			expect(await d.leaseStore.get(refA)).toBeNull();
		});

		it("is a no-op for an unknown conversation", async () => {
			await expect(
				d.manager.terminate(refA, silentLogger),
			).resolves.toBeUndefined();
			expect(d.killSandbox).not.toHaveBeenCalled();
		});
	});
});
