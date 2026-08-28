import { expect, it } from "bun:test";
import {
	createHarnessWorkspaceAttacher,
	type E2bSandboxFactory,
} from "./harness-workspace";

const config = {
	E2B_API_KEY: "e2b-key",
	WORKER_E2B_TEMPLATE: "mymemo-agent-sandbox",
	HARNESS_SANDBOX_TIMEOUT_MS: 600_000,
};
const ref = { userId: "user-1", conversationId: "conv-1" };

/** Fake `e2b` factory recording every call; `connect` optionally throws. */
function fakeE2b(connectError?: Error) {
	const calls: unknown[] = [];
	const warnings: unknown[] = [];
	const factory: E2bSandboxFactory = {
		async connect(sandboxId, options) {
			calls.push({ connect: [sandboxId, options] });
			if (connectError) throw connectError;
			return { sandboxId };
		},
		async create(template, options) {
			calls.push({ create: [template, options] });
			return { sandboxId: "sbx-new" };
		},
	};
	const attach = createHarnessWorkspaceAttacher(
		config,
		{ warn: (obj, msg) => warnings.push({ obj, msg }) },
		factory,
	);
	return { attach, calls, warnings };
}

it("connects to the recorded sandbox, passing the idle window once", async () => {
	const { attach, calls, warnings } = fakeE2b();
	expect(await attach({ ...ref, sandboxId: "sbx-1" })).toEqual({
		sandbox: { sandboxId: "sbx-1" },
		isNew: false,
	});
	expect(calls).toEqual([
		{ connect: ["sbx-1", { apiKey: "e2b-key", timeoutMs: 600_000 }] },
	]);
	expect(warnings).toEqual([]);
});

it("creates a fresh sandbox from the pinned template when the Conversation has none", async () => {
	const { attach, calls } = fakeE2b();
	expect(await attach({ ...ref, sandboxId: null })).toEqual({
		sandbox: { sandboxId: "sbx-new" },
		isNew: true,
	});
	expect(calls).toEqual([
		{
			create: [
				"mymemo-agent-sandbox",
				{
					apiKey: "e2b-key",
					timeoutMs: 600_000,
					lifecycle: { onTimeout: "pause" },
					metadata: ref,
				},
			],
		},
	]);
});

it("creates a fresh sandbox and warns when connecting to the recorded one throws", async () => {
	const { attach, calls, warnings } = fakeE2b(new Error("sandbox gone"));
	expect(await attach({ ...ref, sandboxId: "sbx-1" })).toEqual({
		sandbox: { sandboxId: "sbx-new" },
		isNew: true,
	});
	expect(calls.map((c) => Object.keys(c as object)[0])).toEqual([
		"connect",
		"create",
	]);
	expect(warnings).toEqual([
		{
			obj: {
				err: expect.any(Error),
				conversationId: "conv-1",
				sandboxId: "sbx-1",
			},
			msg: "harness workspace connect failed; creating a fresh sandbox",
		},
	]);
});
