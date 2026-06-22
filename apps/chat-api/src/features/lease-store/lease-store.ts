/**
 * Durable sandbox-lease registry. A lease maps a conversation to the warm
 * sandbox currently serving it, so a turn can reuse a healthy sandbox instead of
 * creating a fresh one. The mapping must outlive a single chat-api process — a
 * restart or a second replica has to find the same warm sandbox — so it lives in
 * Postgres behind this seam rather than in a per-process Map.
 *
 * What is stored is the *pointer*, not the live sandbox: a sandbox handle is an
 * open network client that cannot be serialized. A reusing process reattaches to
 * the sandbox by id through the `SandboxProvider`; this store only persists the
 * id plus the daemon endpoint needed to reach it.
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
	/** The leased sandbox; a reusing process reattaches via the provider. */
	sandboxId: string;
	/** Where the in-sandbox daemon is reachable. */
	daemonUrl: string;
	/** Per-sandbox E2B edge token, or null for providers with no edge (local). */
	trafficAccessToken: string | null;
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
}
