import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertValidConversationId,
	createConversationWorkspace,
	resolveConversationWorkspace,
} from "./workspace";

// Workspace root is injected, not read from env — point it at a temp dir so the
// tests never touch the host's real /workspace.
const testRoot = join(tmpdir(), `workspace-test-${Date.now()}`);

beforeAll(() => {
	mkdirSync(testRoot, { recursive: true });
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
});

describe("assertValidConversationId", () => {
	it("accepts uuid/nanoid-shaped ids", () => {
		for (const id of [
			"conv-1",
			"abc123",
			"a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			"V1StGXR8_Z5jdHi6B-myT",
		]) {
			expect(() => assertValidConversationId(id)).not.toThrow();
		}
	});

	it("rejects ids that could escape the conversation subtree", () => {
		for (const id of [
			"",
			"..",
			"../sibling",
			"../../etc/passwd",
			"a/b",
			"foo/../bar",
			"conv 1",
			"conv.1",
			"conv\0null",
			"a".repeat(129),
		]) {
			expect(() => assertValidConversationId(id)).toThrow(
				/Invalid conversationId/,
			);
		}
	});

	it("rejects non-string values", () => {
		expect(() => assertValidConversationId(undefined)).toThrow();
		expect(() => assertValidConversationId(123 as unknown)).toThrow();
	});
});

describe("resolveConversationWorkspace", () => {
	it("builds the target layout under the workspace root", () => {
		const ws = resolveConversationWorkspace("conv-99", testRoot);
		expect(ws).toEqual({
			root: testRoot,
			system: join(testRoot, "system"),
			conversation: join(testRoot, "conversations", "conv-99"),
			docs: join(testRoot, "conversations", "conv-99", "docs"),
			work: join(testRoot, "conversations", "conv-99", "work"),
			output: join(testRoot, "conversations", "conv-99", "output"),
			claudeConfig: join(testRoot, "conversations", "conv-99", "claude-config"),
		});
	});

	it("throws on a malformed id before constructing any path", () => {
		expect(() => resolveConversationWorkspace("../escape", testRoot)).toThrow(
			/Invalid conversationId/,
		);
	});
});

describe("createConversationWorkspace", () => {
	it("creates system, docs, work, output, and claude-config directories", () => {
		const ws = createConversationWorkspace("conv-create", testRoot);
		for (const dir of [
			ws.system,
			ws.docs,
			ws.work,
			ws.output,
			ws.claudeConfig,
		]) {
			expect(existsSync(dir)).toBe(true);
			expect(statSync(dir).isDirectory()).toBe(true);
		}
	});

	it("is idempotent", () => {
		expect(() =>
			createConversationWorkspace("conv-twice", testRoot),
		).not.toThrow();
		expect(() =>
			createConversationWorkspace("conv-twice", testRoot),
		).not.toThrow();
		expect(
			existsSync(join(testRoot, "conversations", "conv-twice", "work")),
		).toBe(true);
	});

	it("refuses to create directories for a malformed id", () => {
		expect(() => createConversationWorkspace("../../pwned", testRoot)).toThrow(
			/Invalid conversationId/,
		);
		expect(existsSync(join(testRoot, "..", "pwned"))).toBe(false);
	});
});
