/**
 * Local filesystem adapter for {@link WorkspaceStore}. Stores durable workspace
 * state under a single root directory following the durable path model in
 * `paths.ts`. In production the root should be a mounted persistent volume; in
 * tests it points at a temp dir.
 *
 * Scope note: `hydrate`/`sync` currently establish and preserve the durable
 * layout and manifest. Copying the agent's `work/` and `output/` files between
 * the sandbox and durable storage requires a sandbox file bridge that does not
 * exist yet (the daemon proxy only streams events), so it is left to a later
 * task. The abstraction and call sites are in place so that wiring is additive.
 */

import { mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
	type DocsManifest,
	readDocsManifest as readManifestFromDir,
	writeDocsManifest as writeManifestToDir,
} from "./docs-manifest";
import {
	resolveDurableConversationPaths,
	resolveDurableRunEventsPath,
} from "./paths";
import type {
	ConversationRef,
	HydrateResult,
	RunEvent,
	RunRef,
	WorkspaceStore,
} from "./workspace-store";

export class LocalWorkspaceStore implements WorkspaceStore {
	constructor(private readonly rootDir: string) {}

	private conversationPaths(ref: ConversationRef) {
		return resolveDurableConversationPaths(
			this.rootDir,
			ref.userId,
			ref.conversationId,
		);
	}

	private ensureConversationLayout(ref: ConversationRef) {
		const paths = this.conversationPaths(ref);
		mkdirSync(paths.work, { recursive: true });
		mkdirSync(paths.output, { recursive: true });
		mkdirSync(paths.docs, { recursive: true });
		return paths;
	}

	async hydrateConversationWorkspace(
		ref: ConversationRef,
	): Promise<HydrateResult> {
		const paths = this.ensureConversationLayout(ref);
		return { paths, docsManifest: readManifestFromDir(paths.docs) };
	}

	async syncConversationWorkspace(ref: ConversationRef): Promise<void> {
		this.ensureConversationLayout(ref);
	}

	async readDocsManifest(ref: ConversationRef): Promise<DocsManifest> {
		return readManifestFromDir(this.conversationPaths(ref).docs);
	}

	async writeDocsManifest(
		ref: ConversationRef,
		manifest: DocsManifest,
	): Promise<void> {
		const paths = this.conversationPaths(ref);
		mkdirSync(paths.docs, { recursive: true });
		writeManifestToDir(paths.docs, manifest);
	}

	async appendRunEvent(ref: RunRef, event: RunEvent): Promise<void> {
		// Hot path: wired through the run-event sink, this runs once per streamed
		// token. Use async fs so the write yields the event loop instead of
		// blocking it, and create the run directory lazily — only the first event
		// of a run pays the mkdir, after which a single append is the whole cost
		// (no per-event mkdir, and no unbounded "created dirs" memo to leak).
		const file = resolveDurableRunEventsPath(
			this.rootDir,
			ref.userId,
			ref.runId,
		);
		const line = `${JSON.stringify(event)}\n`;
		try {
			await appendFile(file, line, "utf8");
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
			await mkdir(dirname(file), { recursive: true });
			await appendFile(file, line, "utf8");
		}
	}
}

export function createLocalWorkspaceStore(rootDir: string): WorkspaceStore {
	return new LocalWorkspaceStore(rootDir);
}
