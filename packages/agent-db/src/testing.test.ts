import { afterAll, afterEach, describe, expect, it, spyOn } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { createTestDatabase } from "./testing";

// The real WASM trap (pglite#831) cannot be provoked deterministically, so
// these tests drive the retry through the injected client factory with fakes
// that reject `waitReady` the way a trapped boot does.

interface FakeClient {
	client: PGlite;
	closed: () => boolean;
}

function fakeClient(bootError?: unknown): FakeClient {
	let closed = false;
	const client = {
		waitReady:
			bootError === undefined ? Promise.resolve() : Promise.reject(bootError),
		exec: async () => {},
		close: async () => {
			closed = true;
		},
	} as unknown as PGlite;
	return { client, closed: () => closed };
}

function trap(): WebAssembly.RuntimeError {
	return new WebAssembly.RuntimeError("access to a null reference");
}

const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

afterEach(() => {
	warnSpy.mockClear();
});

// bun test shares one process across files — restore the global spy so later
// files keep their console.warn.
afterAll(() => {
	warnSpy.mockRestore();
});

describe("createTestDatabase boot retry", () => {
	it("retries a WASM-trapped boot on a fresh instance and succeeds", async () => {
		const trapped = fakeClient(trap());
		const healthy = fakeClient();
		const attempts: FakeClient[] = [trapped, healthy];

		const tdb = await createTestDatabase(() => {
			const next = attempts.shift();
			if (!next) throw new Error("factory exhausted");
			return next.client;
		});

		expect(attempts).toHaveLength(0); // both attempts consumed
		expect(trapped.closed()).toBe(true); // trapped instance was released
		expect(healthy.closed()).toBe(false);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		await tdb.close();
		expect(healthy.closed()).toBe(true);
	});

	it("gives up after two trapped attempts", async () => {
		let boots = 0;
		await expect(
			createTestDatabase(() => {
				boots++;
				return fakeClient(trap()).client;
			}),
		).rejects.toBeInstanceOf(WebAssembly.RuntimeError);
		expect(boots).toBe(2);
	});

	it("does not retry ordinary boot failures", async () => {
		let boots = 0;
		const deterministic = new Error("migration is broken");
		await expect(
			createTestDatabase(() => {
				boots++;
				return fakeClient(deterministic).client;
			}),
		).rejects.toBe(deterministic);
		expect(boots).toBe(1);
		expect(warnSpy).not.toHaveBeenCalled();
	});
});
