/**
 * Durable sandbox-lease registry. One row per conversation carries two concerns:
 *
 *  1. An **ownership lease** — the concurrency control. A turn `claimLease`s the
 *     conversation (an atomic compare-and-set: take it only if free or expired),
 *     heartbeats it forward via `renewLease` while running, and clears it on
 *     `releaseLease`/`dropLease`. This serializes turns per conversation across
 *     replicas without any advisory lock or in-process map: a crashed owner's
 *     lease simply expires and another replica can steal it. A monotonic
 *     `fencingToken` (bumped on every claim) scopes renew/release to the exact
 *     hold that acquired it, so a stolen hold's late writes become no-ops.
 *
 *  2. A **warm-sandbox pointer** — a disposable optimization. Only the sandbox
 *     *id* (+ resume session) is stored; the daemon URL and per-sandbox edge
 *     token are recomputed from the reattached handle, never persisted. The
 *     pointer survives between turns so the next turn can reuse the sandbox. A
 *     lost or stale pointer only costs a fresh sandbox + hydrate, never
 *     correctness — durable conversation state lives in `WorkspaceStore`.
 */

/** Identifies the conversation a lease belongs to, scoped to its owner. */
export interface LeaseRef {
	userId: string;
	conversationId: string;
}

/**
 * Granted to the caller when `claimLease` wins ownership. `fencingToken`
 * identifies this hold (passed back to `renewLease`/`releaseLease`/`dropLease`);
 * `sandboxId`/`agentSessionId` are the existing warm pointer to reuse, or null on
 * a freshly created row.
 */
export interface LeaseClaim {
	fencingToken: number;
	sandboxId: string | null;
	agentSessionId: string | null;
}

/** The warm pointer as read back by `get` (for the standalone teardown hook). */
export interface LeaseRecord {
	userId: string;
	conversationId: string;
	sandboxId: string | null;
	agentSessionId: string | null;
}

/**
 * Persistence seam for the lease registry, keyed by `{userId, conversationId}`.
 * The lease manager owns the lifecycle; the store is just the atomic SQL.
 */
export interface LeaseStore {
	/**
	 * Atomically claim the conversation's lease for `ownerId`, taking it only if
	 * it is free (released) or its lease has expired (previous owner crashed).
	 * Sets the lease deadline to `now + ttlMs` and bumps the fencing token.
	 * Returns the granted {@link LeaseClaim}, or `null` when another owner holds an
	 * unexpired lease — which the caller surfaces as `ConversationBusyError`.
	 */
	claimLease(
		ref: LeaseRef,
		ownerId: string,
		ttlMs: number,
	): Promise<LeaseClaim | null>;

	/**
	 * Heartbeat: extend the lease deadline to `now + ttlMs`, but only if this hold
	 * (`ownerId` + `fencingToken`) still owns it. Returns `false` when the hold was
	 * lost (stolen after an expiry), which tells the caller to abort its turn.
	 */
	renewLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
		ttlMs: number,
	): Promise<boolean>;

	/**
	 * End a successful turn: clear ownership (leaving the sandbox warm for the next
	 * turn) and persist the warm pointer. Guarded by `ownerId` + `fencingToken`, so
	 * a hold that was stolen mid-turn cannot clobber the new owner's row.
	 */
	releaseLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
		pointer: { sandboxId: string; agentSessionId: string | null },
	): Promise<void>;

	/**
	 * End a failed turn: delete the row so the next turn starts fresh. Same
	 * owner+token guard as {@link releaseLease}. The caller kills the sandbox.
	 */
	dropLease(
		ref: LeaseRef,
		ownerId: string,
		fencingToken: number,
	): Promise<void>;

	/** Read the warm pointer — for the unconditional teardown/recycle hook. */
	get(ref: LeaseRef): Promise<LeaseRecord | null>;

	/** Unconditional delete — for the teardown/recycle hook (not owner-scoped). */
	delete(ref: LeaseRef): Promise<void>;
}
