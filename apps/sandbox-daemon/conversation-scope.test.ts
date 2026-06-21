import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	bindConversationScope,
	ConversationScopeMismatchError,
	conversationScopePath,
	MalformedScopeError,
	normalizeScope,
	readConversationScope,
	scopeFingerprint,
} from "./conversation-scope";

describe("normalizeScope", () => {
	it("keeps only the collectionId for collection scope", () => {
		expect(
			normalizeScope({
				scopeType: "collection",
				collectionId: "col-1",
				summaryId: "sum-stray",
			}),
		).toEqual({
			scopeType: "collection",
			collectionId: "col-1",
			summaryId: null,
		});
	});

	it("keeps only the summaryId for document scope", () => {
		expect(
			normalizeScope({
				scopeType: "document",
				collectionId: "col-stray",
				summaryId: "sum-1",
			}),
		).toEqual({
			scopeType: "document",
			collectionId: null,
			summaryId: "sum-1",
		});
	});

	it("drops ids and falls back to global for unknown or missing scope type", () => {
		expect(
			normalizeScope({ collectionId: "col-1", summaryId: "sum-1" }),
		).toEqual({ scopeType: "global", collectionId: null, summaryId: null });
		expect(normalizeScope({ scopeType: "nonsense" })).toEqual({
			scopeType: "global",
			collectionId: null,
			summaryId: null,
		});
	});
});

describe("scopeFingerprint", () => {
	it("distinguishes scopes by type and id", () => {
		const global = scopeFingerprint(normalizeScope({ scopeType: "global" }));
		const colA = scopeFingerprint(
			normalizeScope({ scopeType: "collection", collectionId: "a" }),
		);
		const colB = scopeFingerprint(
			normalizeScope({ scopeType: "collection", collectionId: "b" }),
		);
		expect(new Set([global, colA, colB]).size).toBe(3);
	});
});

describe("bindConversationScope", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `conv-scope-${Date.now()}-${Math.random()}`);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("establishes the scope on the first turn and persists it", () => {
		const bound = bindConversationScope(dir, {
			scopeType: "collection",
			collectionId: "col-1",
		});
		expect(bound).toEqual({
			scopeType: "collection",
			collectionId: "col-1",
			summaryId: null,
		});
		// Persisted to disk for the next turn.
		expect(readConversationScope(dir)).toEqual(bound);
	});

	it("is a no-op when a later turn uses the same scope", () => {
		bindConversationScope(dir, {
			scopeType: "collection",
			collectionId: "col-1",
		});
		expect(() =>
			bindConversationScope(dir, {
				scopeType: "collection",
				collectionId: "col-1",
				// A stray summaryId is normalized away, so this still matches.
				summaryId: "ignored",
			}),
		).not.toThrow();
	});

	it("rejects a narrower scope in the same conversation (the MYM-39 leak)", () => {
		bindConversationScope(dir, { scopeType: "global" });
		expect(() =>
			bindConversationScope(dir, {
				scopeType: "document",
				summaryId: "sum-1",
			}),
		).toThrow(ConversationScopeMismatchError);
	});

	it("rejects switching to a different id within the same scope type", () => {
		bindConversationScope(dir, {
			scopeType: "collection",
			collectionId: "col-1",
		});
		expect(() =>
			bindConversationScope(dir, {
				scopeType: "collection",
				collectionId: "col-2",
			}),
		).toThrow(ConversationScopeMismatchError);
	});

	it("does not rewrite the established scope when a mismatched turn is rejected", () => {
		const original = bindConversationScope(dir, { scopeType: "global" });
		try {
			bindConversationScope(dir, {
				scopeType: "collection",
				collectionId: "x",
			});
		} catch {
			// expected
		}
		expect(readConversationScope(dir)).toEqual(original);
	});

	it("fails closed on a malformed scope file rather than rebinding", () => {
		mkdirSync(dir, { recursive: true });
		writeFileSync(conversationScopePath(dir), "{ not json", "utf8");
		expect(() => bindConversationScope(dir, { scopeType: "global" })).toThrow(
			MalformedScopeError,
		);
	});
});

describe("readConversationScope", () => {
	let dir: string;

	beforeEach(() => {
		dir = join(tmpdir(), `conv-scope-read-${Date.now()}-${Math.random()}`);
		mkdirSync(dir, { recursive: true });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns null when no scope is established yet", () => {
		expect(readConversationScope(dir)).toBeNull();
	});

	it("rejects an unsupported version", () => {
		writeFileSync(
			conversationScopePath(dir),
			JSON.stringify({ version: 99, scopeType: "global" }),
			"utf8",
		);
		expect(() => readConversationScope(dir)).toThrow(MalformedScopeError);
	});
});
