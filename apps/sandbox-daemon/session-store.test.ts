import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionKey } from "@anthropic-ai/claude-agent-sdk";
import { createSessionStore, FileSystemSessionStore } from "./session-store";

const testRoot = join(tmpdir(), `session-store-test-${Date.now()}`);

beforeAll(() => {
	mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

const USER = "member-code-abc";
const CONVERSATION = "conv-1";
const SESSION = "11111111-2222-3333-4444-555555555555";

function makeStore(
	overrides: Partial<{
		userId: string;
		conversationId: string;
	}> = {},
): FileSystemSessionStore {
	return new FileSystemSessionStore({
		rootDir: testRoot,
		userId: overrides.userId ?? USER,
		conversationId: overrides.conversationId ?? CONVERSATION,
	});
}

// projectKey is SDK-derived from cwd; the store must ignore it for tenancy.
function key(sessionId: string, subpath?: string): SessionKey {
	return { projectKey: "ignored-cwd-key", sessionId, subpath };
}

describe("FileSystemSessionStore append/load", () => {
	it("loads back the entries it appended, in order", async () => {
		const store = makeStore();
		const k = key(SESSION);
		const entries = [
			{ type: "user", uuid: "a", text: "hi" },
			{ type: "assistant", uuid: "b", text: "hello" },
		];

		await store.append(k, entries);
		const loaded = await store.load(k);

		expect(loaded).toEqual(entries);
	});

	it("preserves order across multiple append batches", async () => {
		const store = makeStore({ conversationId: "conv-batches" });
		const k = key(SESSION);

		await store.append(k, [{ type: "user", uuid: "1" }]);
		await store.append(k, [
			{ type: "assistant", uuid: "2" },
			{ type: "user", uuid: "3" },
		]);
		await store.append(k, [{ type: "assistant", uuid: "4" }]);

		const loaded = await store.load(k);
		expect((loaded ?? []).map((e) => e.uuid)).toEqual(["1", "2", "3", "4"]);
	});

	it("returns null for a session that was never written", async () => {
		const store = makeStore({ conversationId: "conv-empty" });
		expect(await store.load(key("never-written"))).toBeNull();
	});

	it("treats an empty append batch as a no-op (still unknown)", async () => {
		const store = makeStore({ conversationId: "conv-noop" });
		const k = key(SESSION);
		await store.append(k, []);
		expect(await store.load(k)).toBeNull();
	});

	it("tolerates a truncated trailing line instead of failing the whole load", async () => {
		// Simulate a turn SIGKILL'd mid-append: intact entries followed by a
		// truncated final JSON object. load() must return the intact prefix, not
		// throw (which would fail the resuming turn entirely).
		const store = makeStore({ conversationId: "conv-truncated" });
		const k = key("truncated-session");
		await store.append(k, [
			{ type: "user", uuid: "1" },
			{ type: "assistant", uuid: "2" },
		]);
		const file = join(
			testRoot,
			"users",
			createHash("sha256").update(USER, "utf8").digest("hex"),
			"conversations",
			"conv-truncated",
			"sessions",
			"truncated-session.jsonl",
		);
		appendFileSync(file, '{"type":"user","uuid":"3"', "utf8"); // truncated, no newline

		const loaded = await store.load(k);
		expect((loaded ?? []).map((e) => e.uuid)).toEqual(["1", "2"]);
	});
});

describe("resume across a fresh daemon/sandbox context", () => {
	it("a new store instance loads a transcript written by an earlier one", async () => {
		const conversationId = "conv-resume";
		const k = key("resume-session");
		const entries = [
			{ type: "user", uuid: "x" },
			{ type: "assistant", uuid: "y" },
		];

		// First sandbox: write the transcript, then it goes away.
		await makeStore({ conversationId }).append(k, entries);

		// Fresh sandbox/daemon: brand-new store over the same durable root.
		const resumed = await makeStore({ conversationId }).load(k);
		expect(resumed).toEqual(entries);
	});
});

describe("tenant isolation", () => {
	it("does not leak a transcript across users", async () => {
		const conversationId = "conv-shared-id";
		const k = key("shared-session");
		await makeStore({ userId: "user-a", conversationId }).append(k, [
			{ type: "user", uuid: "secret" },
		]);

		const other = await makeStore({ userId: "user-b", conversationId }).load(k);
		expect(other).toBeNull();
	});

	it("does not leak a transcript across conversations", async () => {
		const k = key("shared-session-2");
		await makeStore({ conversationId: "conv-x" }).append(k, [
			{ type: "user", uuid: "secret" },
		]);

		const other = await makeStore({ conversationId: "conv-y" }).load(k);
		expect(other).toBeNull();
	});
});

describe("path/key traversal rejection", () => {
	const store = makeStore({ conversationId: "conv-traversal" });

	it("rejects a sessionId that could escape the sessions dir", async () => {
		for (const bad of [
			"..",
			"../sibling",
			"../../etc/passwd",
			"a/b",
			"foo/../bar",
			"sess\0null",
			"",
			"a".repeat(129),
		]) {
			await expect(store.append(key(bad), [{ type: "user" }])).rejects.toThrow(
				/Invalid sessionId/,
			);
			await expect(store.load(key(bad))).rejects.toThrow(/Invalid sessionId/);
		}
	});

	it("rejects a subpath that could escape the session dir", async () => {
		for (const bad of ["..", "../x", "a/../b", "/abs", "sub\0null", ""]) {
			await expect(
				store.append(key(SESSION, bad), [{ type: "user" }]),
			).rejects.toThrow(/Invalid session subpath/);
		}
	});

	it("accepts a well-formed nested subpath", async () => {
		const k = key(SESSION, "subagents/agent-7");
		await store.append(k, [{ type: "user", uuid: "sub" }]);
		expect(await store.load(k)).toEqual([{ type: "user", uuid: "sub" }]);
	});

	it("rejects a malformed conversationId at construction", () => {
		expect(() => makeStore({ conversationId: "../escape" })).toThrow(
			/Invalid conversationId/,
		);
		expect(existsSync(join(testRoot, "..", "escape"))).toBe(false);
	});

	it("rejects an empty userId at construction", () => {
		expect(() => makeStore({ userId: "" })).toThrow(/Invalid userId/);
	});
});

describe("createSessionStore", () => {
	it("returns null when durable storage is not configured", () => {
		expect(createSessionStore({})).toBeNull();
		expect(createSessionStore({ rootDir: testRoot })).toBeNull();
		expect(createSessionStore({ rootDir: testRoot, userId: USER })).toBeNull();
		expect(
			createSessionStore({ userId: USER, conversationId: CONVERSATION }),
		).toBeNull();
	});

	it("returns a store when root and identity are all present", () => {
		const store = createSessionStore({
			rootDir: testRoot,
			userId: USER,
			conversationId: CONVERSATION,
		});
		expect(store).toBeInstanceOf(FileSystemSessionStore);
	});
});
