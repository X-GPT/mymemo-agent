import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { Pool, type PoolClient } from "pg";
import type { AdvisoryLockPool } from "./advisory-lock";
import type { PublisherLogger } from "./logger";
import { publishAgentCoreDispatchTick } from "./publisher-loop";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const shouldRun =
	DB_URL !== "" &&
	process.env.RUN_AGENTCORE_PUBLISHER_POSTGRES_TESTS === "true";
if (shouldRun) setDefaultTimeout(30_000);

const silentLogger: PublisherLogger = { info() {}, error() {} };
let pool: Pool;

function publication() {
	return {
		status: "enabled" as const,
		publishedRunIds: ["run-481"],
		ambiguousRunIds: [],
	};
}

function deferred() {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((done) => {
			resolve = done;
		}),
		resolve,
	};
}

function runTick(options: {
	pool?: AdvisoryLockPool;
	publishPending(): Promise<ReturnType<typeof publication>>;
}) {
	return publishAgentCoreDispatchTick({
		pool: options.pool ?? pool,
		publisher: { publishPending: options.publishPending },
		pendingStore: { oldestUnpublishedAdmittedAt: async () => null },
		logger: silentLogger,
	});
}

class CapturingPool implements AdvisoryLockPool {
	client: PoolClient | undefined;

	constructor(private readonly delegate: Pool) {}

	async connect(): Promise<PoolClient> {
		this.client = await this.delegate.connect();
		return this.client;
	}
}

describe.skipIf(!shouldRun)("publisher lock against real Postgres", () => {
	beforeAll(() => {
		pool = new Pool({ connectionString: DB_URL, max: 6 });
	});

	afterAll(async () => {
		await pool.end();
	});

	it("lets exactly one overlapping task publish", async () => {
		const entered = deferred();
		const finish = deferred();
		let firstCalls = 0;
		let secondCalls = 0;
		const firstTick = runTick({
			publishPending: async () => {
				firstCalls += 1;
				entered.resolve();
				await finish.promise;
				return publication();
			},
		});

		await entered.promise;
		await expect(
			runTick({
				publishPending: async () => {
					secondCalls += 1;
					return publication();
				},
			}),
		).resolves.toEqual({ outcome: "lost_lock" });
		expect([firstCalls, secondCalls]).toEqual([1, 0]);

		finish.resolve();
		await expect(firstTick).resolves.toEqual({
			outcome: "published",
			pendingAgeMs: 0,
		});
	});

	it("releases the lock when its database backend terminates", async () => {
		const capturedPool = new CapturingPool(pool);
		const entered = deferred();
		const finish = deferred();
		const killedTick = runTick({
			pool: capturedPool,
			publishPending: async () => {
				entered.resolve();
				await finish.promise;
				return publication();
			},
		});

		await entered.promise;
		const backend = await capturedPool.client?.query<{ pid: number }>(
			"select pg_backend_pid() as pid",
		);
		const processId = backend?.rows[0]?.pid;
		if (!processId) throw new Error("publisher backend id was not captured");
		const connectionFailed = new Promise<void>((resolve) => {
			capturedPool.client?.once("error", () => resolve());
		});
		await pool.query("select pg_terminate_backend($1)", [processId]);
		await connectionFailed;
		finish.resolve();
		await expect(killedTick).rejects.toBeDefined();
		await expect(
			runTick({ publishPending: async () => publication() }),
		).resolves.toEqual({ outcome: "published", pendingAgeMs: 0 });
	});
});
