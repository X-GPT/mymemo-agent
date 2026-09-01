import { describe, expect, it } from "bun:test";
import { createApp } from "./app";

describe("the In-VM server surface", () => {
	it("answers health with liveness", async () => {
		const app = createApp({ nudge: () => {} });
		const res = await app.request("/health");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});

	it("accepts a nudge and fires the drain trigger", async () => {
		let nudges = 0;
		const app = createApp({
			nudge: () => {
				nudges++;
			},
		});
		const res = await app.request("/nudge", { method: "POST" });
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ status: "accepted" });
		expect(nudges).toBe(1);
	});

	it("accepts repeated nudges — idempotency lives in the DB claim gate", async () => {
		let nudges = 0;
		const app = createApp({
			nudge: () => {
				nudges++;
			},
		});
		for (let i = 0; i < 3; i++) {
			const res = await app.request("/nudge", { method: "POST" });
			expect(res.status).toBe(202);
		}
		expect(nudges).toBe(3);
	});

	it("serves nothing else", async () => {
		const app = createApp({ nudge: () => {} });
		expect((await app.request("/")).status).toBe(404);
		expect((await app.request("/nudge")).status).toBe(404);
	});
});
