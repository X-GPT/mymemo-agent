import { describe, expect, it } from "bun:test";
import {
	type AdvisoryLockClient,
	type AdvisoryLockPool,
	tryWithAdvisoryLock,
} from "./advisory-lock";

const KEY = 42;

/** A fake pooled connection recording the SQL it saw and whether it released. */
class FakeClient implements AdvisoryLockClient {
	queries: string[] = [];
	released = false;
	constructor(private readonly locked: boolean) {}

	async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
		this.queries.push(text);
		if (text.includes("pg_try_advisory_lock")) {
			return { rows: [{ locked: this.locked }] };
		}
		return { rows: [] };
	}
	release(): void {
		this.released = true;
	}
}

class FakePool implements AdvisoryLockPool {
	last: FakeClient | undefined;
	constructor(private readonly locked: boolean) {}
	async connect(): Promise<AdvisoryLockClient> {
		this.last = new FakeClient(this.locked);
		return this.last;
	}
}

describe("tryWithAdvisoryLock", () => {
	it("runs fn, unlocks, and releases when the lock is acquired", async () => {
		const pool = new FakePool(true);
		let ran = false;

		const outcome = await tryWithAdvisoryLock(pool, KEY, async () => {
			ran = true;
			return "done";
		});

		expect(outcome).toEqual({ ran: true, result: "done" });
		expect(ran).toBe(true);
		expect(pool.last?.queries).toEqual([
			"select pg_try_advisory_lock($1) as locked",
			"select pg_advisory_unlock($1)",
		]);
		expect(pool.last?.released).toBe(true);
	});

	it("skips fn but still releases when the lock is not acquired", async () => {
		const pool = new FakePool(false);
		let ran = false;

		const outcome = await tryWithAdvisoryLock(pool, KEY, async () => {
			ran = true;
		});

		expect(outcome).toEqual({ ran: false });
		expect(ran).toBe(false);
		// No unlock is issued for a lock we never took.
		expect(pool.last?.queries).toEqual([
			"select pg_try_advisory_lock($1) as locked",
		]);
		expect(pool.last?.released).toBe(true);
	});

	it("unlocks and releases even when fn throws", async () => {
		const pool = new FakePool(true);

		await expect(
			tryWithAdvisoryLock(pool, KEY, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");

		expect(pool.last?.queries).toContain("select pg_advisory_unlock($1)");
		expect(pool.last?.released).toBe(true);
	});
});
