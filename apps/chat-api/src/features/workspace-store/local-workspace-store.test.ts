import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { type DocsManifest, MalformedManifestError } from "./docs-manifest";
import {
	createLocalWorkspaceStore,
	type LocalWorkspaceStore,
} from "./local-workspace-store";
import { encodeUserSegment } from "./paths";

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

		const base = join(
			root,
			"users",
			encodeUserSegment("user-1"),
			"conversations",
			"conv-1",
		);
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
		const base = join(
			root,
			"users",
			encodeUserSegment("user-1"),
			"conversations",
			"conv-1",
		);
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
			encodeUserSegment("user-1"),
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

		const file = join(
			root,
			"users",
			encodeUserSegment("user-1"),
			"runs",
			"run-1",
			"events.jsonl",
		);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((l) => JSON.parse(l))).toEqual([
			{ type: "run_started" },
			{ type: "run_completed", ok: true },
		]);
	});

	it("appends in order across many events (first event creates the dir, rest reuse it)", async () => {
		const ref = { userId: "user-1", runId: "run-2" };
		// First append exercises the lazy-mkdir (ENOENT) branch; the rest exercise
		// the steady-state single-append branch against the now-existing dir.
		for (let i = 0; i < 5; i++) {
			await store.appendRunEvent(ref, { type: "agent_event", i });
		}

		const file = join(
			root,
			"users",
			encodeUserSegment("user-1"),
			"runs",
			"run-2",
			"events.jsonl",
		);
		const lines = readFileSync(file, "utf8").trim().split("\n");
		expect(lines.map((l) => JSON.parse(l).i)).toEqual([0, 1, 2, 3, 4]);
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
		expect(a.paths.conversation).toContain(
			join("users", encodeUserSegment("user-a")),
		);
		expect(b.paths.conversation).toContain(
			join("users", encodeUserSegment("user-b")),
		);
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

	// conversationId and runId are chat-api-allocated in a known-safe shape, so a
	// malformed value is rejected outright.
	const unsafeIds = ["../evil", "..", "a/b", "a\0b", "with space", ""];

	for (const bad of unsafeIds) {
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

	it("rejects an over-long conversationId", async () => {
		await expect(
			store.hydrateConversationWorkspace({
				userId: "user-1",
				conversationId: "c".repeat(129),
			}),
		).rejects.toThrow(/Invalid conversationId/);
	});

	// userId is the caller-supplied member code (unconstrained charset/length),
	// so it is hashed into a path-safe segment rather than rejected — except an
	// empty id, which is never valid.
	it("rejects an empty userId", async () => {
		await expect(
			store.hydrateConversationWorkspace({
				userId: "",
				conversationId: "conv-1",
			}),
		).rejects.toThrow(/Invalid userId/);
	});

	for (const bad of ["../evil", "..", "a/b", "a\0b", "with space"]) {
		it(`neutralizes traversal-prone userId ${JSON.stringify(bad)} instead of escaping root`, async () => {
			const { paths } = await store.hydrateConversationWorkspace({
				userId: bad,
				conversationId: "conv-1",
			});
			// The user segment is a hex hash containing no path separators, so the
			// conversation dir stays strictly under <root>/users.
			expect(paths.conversation.startsWith(join(root, "users") + sep)).toBe(
				true,
			);
			expect(existsSync(paths.work)).toBe(true);
		});
	}

	it("accepts a member-code userId that is not path-safe or over-long", async () => {
		// e.g. an email-shaped member code, or one longer than a filesystem name
		// limit — these worked end-to-end before the durable store existed.
		const memberCode = `${"u".repeat(200)}@corp.com`;
		const { paths } = await store.hydrateConversationWorkspace({
			userId: memberCode,
			conversationId: "conv-1",
		});
		expect(existsSync(paths.work)).toBe(true);
		expect(encodeUserSegment(memberCode)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("maps distinct member codes to distinct user segments", async () => {
		expect(encodeUserSegment("user-a")).not.toBe(encodeUserSegment("user-b"));
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
