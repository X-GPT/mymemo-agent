import { describe, expect, it } from "bun:test";
import { type AppHandlers, createApp } from "./app";

function handlers(overrides: Partial<AppHandlers> = {}): AppHandlers {
	return {
		nudge: () => true,
		run: async () => {},
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
		let nudges = 0;
		const app = createApp(
			handlers({
				nudge: () => {
					nudges++;
					return true;
				},
			}),
		);
		const res = await app.request("/nudge", { method: "POST" });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ status: "accepted" });
		expect(nudges).toBe(1);
	});

	it("answers 503 to a nudge before the run hook configures the server", async () => {
		const app = createApp(handlers({ nudge: () => false }));
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
		"resume",
		"suspend",
		"terminate",
	])("answers the %s lifecycle hook with 200", async (hook) => {
		const app = createApp(handlers());
		const res = await app.request(`/aws/lambda-microvms/runtime/v1/${hook}`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
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
