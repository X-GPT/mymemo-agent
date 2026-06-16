import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DocsManifest, MalformedManifestError } from "./docs-manifest";
import {
	createLocalWorkspaceStore,
	type LocalWorkspaceStore,
} from "./local-workspace-store";

let root: string;
let store: LocalWorkspaceStore;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workspace-store-test-"));
	store = createLocalWorkspaceStore(root) as LocalWorkspaceStore;
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

function manifest(documents: DocsManifest["documents"] = []): DocsManifest {
	return { version: 1, documents };
}

describe("LocalWorkspaceStore durable path model", () => {
	it("hydrate creates work, output, and docs under users/{userId}/conversations/{conversationId}", async () => {
		const { paths, docsManifest } = await store.hydrateConversationWorkspace({
			userId: "user-1",
			conversationId: "conv-1",
		});

		const base = join(root, "users", "user-1", "conversations", "conv-1");
		expect(paths.conversation).toBe(base);
		expect(paths.work).toBe(join(base, "work"));
		expect(paths.output).toBe(join(base, "output"));
		expect(paths.docs).toBe(join(base, "docs"));
		expect(existsSync(paths.work)).toBe(true);
		expect(existsSync(paths.output)).toBe(true);
		expect(existsSync(paths.docs)).toBe(true);
		// A fresh conversation has an empty working set.
		expect(docsManifest).toEqual(manifest());
	});

	it("hydrate is idempotent and preserves an existing manifest", async () => {
		const ref = { userId: "user-1", conversationId: "conv-1" };
		await store.hydrateConversationWorkspace(ref);
		const entry = {
			documentId: "doc-1",
			title: "Doc 1",
			localPath: "doc-1.md",
			source: "kb",
			hydratedAt: "2026-06-16T00:00:00.000Z",
			runId: "run-1",
		};
		await store.writeDocsManifest(ref, manifest([entry]));

		const { docsManifest } = await store.hydrateConversationWorkspace(ref);
		expect(docsManifest.documents).toEqual([entry]);
	});

	it("sync ensures the durable layout exists", async () => {
		const ref = { userId: "user-1", conversationId: "conv-1" };
		await store.syncConversationWorkspace(ref);
		const base = join(root, "users", "user-1", "conversations", "conv-1");
		expect(existsSync(join(base, "work"))).toBe(true);
		expect(existsSync(join(base, "output"))).toBe(true);
		expect(existsSync(join(base, "docs"))).toBe(true);
	});

	it("writes the docs manifest at users/{userId}/conversations/{conversationId}/docs/manifest.json", async () => {
		const ref = { userId: "user-1", conversationId: "conv-1" };
		await store.writeDocsManifest(ref, manifest());
		const manifestPath = join(
			root,
			"users",
			"user-1",
			"conversations",
			"conv-1",
			"docs",
			"manifest.json",
		);
		expect(existsSync(manifestPath)).toBe(true);
	});

	it("appends run events as NDJSON at users/{userId}/runs/{runId}/events.jsonl", async () => {
		const ref = { userId: "user-1", runId: "run-1" };
		await store.appendRunEvent(ref, { type: "run_started" });
		await store.appendRunEvent(ref, { type: "run_completed", ok: true });

		const file = join(root, "users", "user-1", "runs", "run-1", "events.jsonl");
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((l) => JSON.parse(l))).toEqual([
			{ type: "run_started" },
			{ type: "run_completed", ok: true },
		]);
	});
});

describe("LocalWorkspaceStore isolation and traversal", () => {
	it("keeps different users in separate trees", async () => {
		const a = await store.hydrateConversationWorkspace({
			userId: "user-a",
			conversationId: "conv-1",
		});
		const b = await store.hydrateConversationWorkspace({
			userId: "user-b",
			conversationId: "conv-1",
		});
		expect(a.paths.conversation).not.toBe(b.paths.conversation);
		expect(a.paths.conversation).toContain(join("users", "user-a"));
		expect(b.paths.conversation).toContain(join("users", "user-b"));
	});

	it("keeps different conversations in separate trees for the same user", async () => {
		const a = await store.hydrateConversationWorkspace({
			userId: "user-1",
			conversationId: "conv-a",
		});
		const b = await store.hydrateConversationWorkspace({
			userId: "user-1",
			conversationId: "conv-b",
		});
		expect(a.paths.conversation).not.toBe(b.paths.conversation);
	});

	it("does not leak one conversation's manifest into another", async () => {
		const entry = {
			documentId: "doc-1",
			title: "Doc 1",
			localPath: "doc-1.md",
			source: "kb",
			hydratedAt: "2026-06-16T00:00:00.000Z",
			runId: "run-1",
		};
		await store.writeDocsManifest(
			{ userId: "user-1", conversationId: "conv-a" },
			manifest([entry]),
		);
		const other = await store.readDocsManifest({
			userId: "user-1",
			conversationId: "conv-b",
		});
		expect(other.documents).toEqual([]);
	});

	const traversalIds = ["../evil", "..", "a/b", "a\0b", "with space", ""];

	for (const bad of traversalIds) {
		it(`rejects traversal-prone userId ${JSON.stringify(bad)}`, async () => {
			await expect(
				store.hydrateConversationWorkspace({
					userId: bad,
					conversationId: "conv-1",
				}),
			).rejects.toThrow(/Invalid userId/);
		});

		it(`rejects traversal-prone conversationId ${JSON.stringify(bad)}`, async () => {
			await expect(
				store.hydrateConversationWorkspace({
					userId: "user-1",
					conversationId: bad,
				}),
			).rejects.toThrow(/Invalid conversationId/);
		});

		it(`rejects traversal-prone runId ${JSON.stringify(bad)}`, async () => {
			await expect(
				store.appendRunEvent({ userId: "user-1", runId: bad }, { type: "x" }),
			).rejects.toThrow(/Invalid runId/);
		});
	}

	it("rejects an over-long id", async () => {
		await expect(
			store.hydrateConversationWorkspace({
				userId: "u".repeat(129),
				conversationId: "conv-1",
			}),
		).rejects.toThrow(/Invalid userId/);
	});
});

describe("LocalWorkspaceStore manifest read failure mode", () => {
	it("fails closed on a corrupt manifest rather than returning empty", async () => {
		const ref = { userId: "user-1", conversationId: "conv-1" };
		const { paths } = await store.hydrateConversationWorkspace(ref);
		writeFileSync(join(paths.docs, "manifest.json"), "{ not json", "utf8");

		await expect(store.readDocsManifest(ref)).rejects.toThrow(
			MalformedManifestError,
		);
	});
});
