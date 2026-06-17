/**
 * Durable workspace store. The sandbox filesystem is ephemeral — a sandbox is
 * leased for a turn and torn down — so the durable record of a conversation's
 * working set lives outside the sandbox, behind this abstraction.
 *
 * The interface is async so a later object-storage adapter can implement it
 * without changing callers; the first adapter (`LocalWorkspaceStore`) is a
 * local filesystem implementation used while the object-storage provider is not
 * finalized.
 */

import type { DocsManifest } from "./docs-manifest";
import type { DurableConversationPaths } from "./paths";

/** Identifies a conversation's durable workspace, scoped to its owner. */
export interface ConversationRef {
	userId: string;
	conversationId: string;
}

/** Identifies a single run's durable event log, scoped to its owner. */
export interface RunRef {
	userId: string;
	runId: string;
}

/**
 * One appended run event. `type` names the event; any other structured fields
 * are carried through verbatim into the NDJSON log.
 */
export interface RunEvent {
	type: string;
	[key: string]: unknown;
}

export interface HydrateResult {
	paths: DurableConversationPaths;
	/** The conversation's current working set as recorded durably. */
	docsManifest: DocsManifest;
}

export interface WorkspaceStore {
	/**
	 * Prepare a conversation's durable workspace before a run and return its
	 * current state. Idempotent.
	 */
	hydrateConversationWorkspace(ref: ConversationRef): Promise<HydrateResult>;

	/**
	 * Persist a conversation's durable workspace after a run (whether it
	 * succeeded, failed, or was canceled). Idempotent.
	 */
	syncConversationWorkspace(ref: ConversationRef): Promise<void>;

	readDocsManifest(ref: ConversationRef): Promise<DocsManifest>;

	writeDocsManifest(
		ref: ConversationRef,
		manifest: DocsManifest,
	): Promise<void>;

	/** Append one event to a run's durable NDJSON event log. */
	appendRunEvent(ref: RunRef, event: RunEvent): Promise<void>;
}
