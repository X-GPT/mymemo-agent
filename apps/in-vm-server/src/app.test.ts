import { describe, expect, it } from "bun:test";
import { type AppHandlers, createApp } from "./app";

function handlers(overrides: Partial<AppHandlers> = {}): AppHandlers {
	return {
		nudge: async () => true,
		run: async () => {},
		suspend: async () => {},
		resume: async () => {},
		...overrides,
	};
}

describe("the In-VM server surface", () => {
	it("answers health with liveness", async () => {
		const app = createApp(handlers());
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("accepts a nudge and fires the drain trigger", async () => {
		const nudges: unknown[] = [];
		const app = createApp(
			handlers({
				nudge: async (command) => {
					nudges.push(command);
					return true;
				},
			}),
		);
		const res = await app.request("/nudge", { method: "POST" });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ status: "accepted" });
		expect(nudges).toEqual([undefined]);
	});

	it("delivers the interrupt command carried by a nudge body, applied before answering", async () => {
		const nudges: unknown[] = [];
		const app = createApp(
			handlers({
				nudge: async (command) => {
					nudges.push(command);
					return true;
				},
			}),
		);
		const res = await app.request("/nudge", {
			method: "POST",
			body: JSON.stringify({ interrupt: "turn-1" }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(202);
		expect(nudges).toEqual([{ interrupt: "turn-1" }]);
	});

	it.each([
		"not json",
		"{}",
		'{"interrupt":7}',
		'{"interrupt":""}',
		'{"interrupt":"turn-1","extra":1}',
	])("rejects a malformed nudge body (%s) without nudging", async (body) => {
		let nudges = 0;
		const app = createApp(
			handlers({
				nudge: async () => {
					nudges++;
					return true;
				},
			}),
		);
		const res = await app.request("/nudge", { method: "POST", body });
		expect(res.status).toBe(400);
		expect(nudges).toBe(0);
	});

	it("a failing interrupt apply answers non-2xx rather than claiming it applied", async () => {
		const app = createApp(
			handlers({
				nudge: async () => {
					throw new Error("database unreachable");
				},
			}),
		);
		const res = await app.request("/nudge", {
			method: "POST",
			body: JSON.stringify({ interrupt: "turn-1" }),
		});
		expect(res.status).toBe(500);
	});

	it("answers 503 to a nudge before the run hook configures the server", async () => {
		const app = createApp(handlers({ nudge: async () => false }));
		const res = await app.request("/nudge", { method: "POST" });
		expect(res.status).toBe(503);
	});

	it("delivers the run hook body (runHookPayload included) to the run handler", async () => {
		let received: unknown;
		const app = createApp(
			handlers({
				run: async (body) => {
					received = body;
				},
			}),
		);
		const res = await app.request("/aws/lambda-microvms/runtime/v1/run", {
			method: "POST",
			body: JSON.stringify({
				microvmId: "mvm-1",
				runHookPayload: '{"MYMEMO_CONVERSATION_ID":"c-1"}',
			}),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(received).toEqual({
			microvmId: "mvm-1",
			runHookPayload: '{"MYMEMO_CONVERSATION_ID":"c-1"}',
		});
	});

	it("a failing run handler answers non-200 so the platform never routes traffic", async () => {
		const app = createApp(
			handlers({
				run: async () => {
					throw new Error("runHookPayload is not valid JSON");
				},
			}),
		);
		const res = await app.request("/aws/lambda-microvms/runtime/v1/run", {
			method: "POST",
			body: "{}",
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(500);
	});

	it.each([
		"ready",
		"terminate",
	])("answers the %s lifecycle hook with 200", async (hook) => {
		const app = createApp(handlers());
		const res = await app.request(`/aws/lambda-microvms/runtime/v1/${hook}`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
	});

	it("answers the suspend hook only once the drain-and-checkpoint handler completes (500 when it fails), and hands resume to its handler", async () => {
		const events: string[] = [];
		const app = createApp(
			handlers({
				suspend: async () => {
					await Bun.sleep(20);
					events.push("checkpointed");
				},
				resume: async () => {
					events.push("resumed");
				},
			}),
		);
		const hook = (name: string) =>
			app.request(`/aws/lambda-microvms/runtime/v1/${name}`, {
				method: "POST",
			});
		expect((await hook("suspend")).status).toBe(200);
		expect((await hook("resume")).status).toBe(200);
		expect(events).toEqual(["checkpointed", "resumed"]);

		const failing = createApp(
			handlers({
				suspend: async () => {
					throw new Error("checkpoint PUT answered 503");
				},
			}),
		);
		expect(
			(
				await failing.request("/aws/lambda-microvms/runtime/v1/suspend", {
					method: "POST",
				})
			).status,
		).toBe(500);
	});

	it("streams the in-VM smoke checks when the image bakes a smoke script", async () => {
		const path = `${import.meta.dir}/testing/smoke-fixture.sh`;
		const app = createApp(handlers({ smokeScriptPath: path }));
		const res = await app.request("/smoke");
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("RESULT fixture PASS");
	});

	it("has no smoke route without a baked script (local runs)", async () => {
		const app = createApp(handlers());
		expect((await app.request("/smoke")).status).toBe(404);
	});

	it("serves nothing else", async () => {
		const app = createApp(handlers());
		expect((await app.request("/")).status).toBe(404);
		expect((await app.request("/nudge")).status).toBe(404);
		expect(
			(
				await app.request("/aws/lambda-microvms/runtime/v1/other", {
					method: "POST",
				})
			).status,
		).toBe(404);
	});
});
