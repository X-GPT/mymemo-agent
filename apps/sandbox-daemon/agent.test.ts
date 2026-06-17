import { describe, expect, it } from "bun:test";
import type { SessionStore } from "@anthropic-ai/claude-agent-sdk";
import { buildQueryOptions } from "./agent";

const base = {
	userQuery: "hello",
	systemPrompt: "be helpful",
	cwd: "/workspace/conversations/c/work",
};

// A no-op store; buildQueryOptions only needs to forward the reference.
const fakeStore: SessionStore = {
	async append() {},
	async load() {
		return null;
	},
};

describe("buildQueryOptions", () => {
	it("forwards a sessionStore to query() when durable storage is configured", () => {
		const opts = buildQueryOptions({ ...base, sessionStore: fakeStore });
		expect(opts.sessionStore).toBe(fakeStore);
	});

	it("omits sessionStore when durable storage is not configured", () => {
		const opts = buildQueryOptions(base);
		expect("sessionStore" in opts).toBe(false);
	});

	it("never disables local writes (persistSession stays unset) with a store", () => {
		// The mirror hook fires after the local write; persistSession:false would
		// silence it. Guard against a regression that pairs them.
		const opts = buildQueryOptions({ ...base, sessionStore: fakeStore });
		expect("persistSession" in opts).toBe(false);
	});

	it("sets resume only when a prior sessionId is supplied", () => {
		expect(buildQueryOptions(base).resume).toBeUndefined();
		expect(buildQueryOptions({ ...base, sessionId: "sess-1" }).resume).toBe(
			"sess-1",
		);
	});
});
