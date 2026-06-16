import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertValidConversationId,
	createConversationWorkspace,
	getWorkspaceRoot,
	resolveConversationWorkspace,
} from "./workspace";

const testRoot = join(tmpdir(), `workspace-test-${Date.now()}`);
const savedRoot = process.env.SANDBOX_WORKSPACE_ROOT;

beforeAll(() => {
	mkdirSync(testRoot, { recursive: true });
	process.env.SANDBOX_WORKSPACE_ROOT = testRoot;
});

afterEach(() => {
	process.env.SANDBOX_WORKSPACE_ROOT = testRoot;
});

afterAll(() => {
	rmSync(testRoot, { recursive: true, force: true });
	if (savedRoot === undefined) delete process.env.SANDBOX_WORKSPACE_ROOT;
	else process.env.SANDBOX_WORKSPACE_ROOT = savedRoot;
});

describe("getWorkspaceRoot", () => {
	it("honors SANDBOX_WORKSPACE_ROOT", () => {
		expect(getWorkspaceRoot()).toBe(testRoot);
	});

	it("defaults to /workspace when unset", () => {
		delete process.env.SANDBOX_WORKSPACE_ROOT;
		expect(getWorkspaceRoot()).toBe("/workspace");
	});
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
		const ws = resolveConversationWorkspace("conv-99");
		expect(ws).toEqual({
			root: testRoot,
			system: join(testRoot, "system"),
			conversation: join(testRoot, "conversations", "conv-99"),
			docs: join(testRoot, "conversations", "conv-99", "docs"),
			work: join(testRoot, "conversations", "conv-99", "work"),
			output: join(testRoot, "conversations", "conv-99", "output"),
		});
	});

	it("throws on a malformed id before constructing any path", () => {
		expect(() => resolveConversationWorkspace("../escape")).toThrow(
			/Invalid conversationId/,
		);
	});
});

describe("createConversationWorkspace", () => {
	it("creates system, docs, work, and output directories", () => {
		const ws = createConversationWorkspace("conv-create");
		for (const dir of [ws.system, ws.docs, ws.work, ws.output]) {
			expect(existsSync(dir)).toBe(true);
			expect(statSync(dir).isDirectory()).toBe(true);
		}
	});

	it("is idempotent", () => {
		expect(() => createConversationWorkspace("conv-twice")).not.toThrow();
		expect(() => createConversationWorkspace("conv-twice")).not.toThrow();
		expect(
			existsSync(join(testRoot, "conversations", "conv-twice", "work")),
		).toBe(true);
	});

	it("refuses to create directories for a malformed id", () => {
		expect(() => createConversationWorkspace("../../pwned")).toThrow(
			/Invalid conversationId/,
		);
		expect(existsSync(join(testRoot, "..", "pwned"))).toBe(false);
	});
});
