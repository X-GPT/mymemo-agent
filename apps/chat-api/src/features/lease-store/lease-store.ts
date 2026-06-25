/**
 * Durable sandbox-lease registry. A lease maps a conversation to the warm
 * sandbox currently serving it, so a turn can reuse a healthy sandbox instead of
 * creating a fresh one. The mapping must outlive a single chat-api process — a
 * restart or a second replica has to find the same warm sandbox — so it lives in
 * Postgres behind this seam rather than in a per-process Map.
 *
 * What is stored is the *pointer*, not the live sandbox: a sandbox handle is an
 * open network client that cannot be serialized. A reusing process reattaches to
 * the sandbox by id through the `SandboxProvider` and recomputes the daemon
 * endpoint from the reattached handle, so the store persists only the id (the
 * URL and per-sandbox edge token are derived, never written here — that keeps
 * the edge secret out of a durable store and the endpoint from going stale).
 *
 * The lease is an optimization, not the source of truth — durable conversation
 * state (transcripts, docs, manifest) lives in `WorkspaceStore`. A lost or stale
 * lease only costs a fresh sandbox + hydrate, never correctness.
 */

/** Identifies the conversation a lease belongs to, scoped to its owner. */
export interface LeaseRef {
	userId: string;
	conversationId: string;
}

/**
 * The persisted pointer to a conversation's warm sandbox. Holds only what a
 * reusing process needs to reattach and reach the daemon — no secrets beyond the
 * per-sandbox edge token, which is scoped to that one sandbox.
 */
export interface LeaseRecord {
	userId: string;
	conversationId: string;
	/**
	 * The leased sandbox. A reusing process reattaches via the provider and
	 * recomputes the daemon endpoint from the handle — the URL and edge token are
	 * deliberately NOT stored.
	 */
	sandboxId: string;
	/** Claude SDK resume state last threaded into this conversation, if any. */
	agentSessionId: string | null;
}

/**
 * Persistence seam for the lease registry, keyed by `{userId, conversationId}`.
 * Small on purpose: the lease manager owns the lifecycle, the store only reads
 * and writes the row. `upsert` replaces any existing row for the key so a fresh
 * sandbox cleanly supersedes a stale one.
 */
export interface LeaseStore {
	get(ref: LeaseRef): Promise<LeaseRecord | null>;
	upsert(record: LeaseRecord): Promise<void>;
	delete(ref: LeaseRef): Promise<void>;
	/**
	 * Run `fn` while holding a cross-process claim on `ref`'s conversation, so only
	 * one acquirer anywhere can be deciding-to-reuse-or-creating for a conversation
	 * at a time. Returns `{ acquired: false }` (without running `fn`) when another
	 * holder has the claim — the caller treats that as `ConversationBusyError`.
	 *
	 * This closes the multi-replica first-turn race the in-process guard cannot:
	 * two replicas that both see no lease would otherwise each create a sandbox.
	 * The claim only needs to cover the read→reuse-or-create→write-pointer section;
	 * once the warm lease row exists, later concurrent turns resolve to the same
	 * sandbox and the daemon's single-turn lock rejects the extra one.
	 */
	withClaim<T>(
		ref: LeaseRef,
		fn: () => Promise<T>,
	): Promise<{ acquired: boolean; result?: T }>;
}
