import {
	afterAll,
	beforeAll,
	describe,
	expect,
	it,
	setDefaultTimeout,
} from "bun:test";
import { Pool, type PoolClient } from "pg";
import type { AdvisoryLockPool } from "../cleanup/advisory-lock";
import type { WorkerLogger } from "../logger";
import { AgentCoreDispatchPublisherLoop } from "./publisher-loop";

const DB_URL = process.env.AGENT_DATABASE_URL ?? "";
const shouldRunPostgresTests =
	DB_URL !== "" &&
	process.env.RUN_AGENTCORE_PUBLISHER_POSTGRES_TESTS === "true";
if (shouldRunPostgresTests) setDefaultTimeout(30_000);

const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };
let pool: Pool;

function enabledPublication() {
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

function loopWith(options: {
	pool?: AdvisoryLockPool;
	publishPending(): Promise<ReturnType<typeof enabledPublication>>;
}) {
	return new AgentCoreDispatchPublisherLoop({
		pool: options.pool ?? pool,
		publisher: { publishPending: options.publishPending },
		pendingStore: { oldestUnpublishedAdmittedAt: async () => null },
		intervalMs: 2_000,
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

describe.skipIf(!shouldRunPostgresTests)(
	"AgentCore dispatch publisher lock against real Postgres",
	() => {
		beforeAll(() => {
			pool = new Pool({ connectionString: DB_URL, max: 6 });
		});

		afterAll(async () => {
			await pool.end();
		});

		it("lets exactly one overlapping loop publish while the loser is a no-op", async () => {
			const entered = deferred();
			const finish = deferred();
			let firstCalls = 0;
			let secondCalls = 0;
			const first = loopWith({
				publishPending: async () => {
					firstCalls += 1;
					entered.resolve();
					await finish.promise;
					return enabledPublication();
				},
			});
			const second = loopWith({
				publishPending: async () => {
					secondCalls += 1;
					return enabledPublication();
				},
			});

			const firstTick = first.runOnce();
			await entered.promise;
			await expect(second.runOnce()).resolves.toEqual({
				outcome: "lost_lock",
			});
			expect([firstCalls, secondCalls]).toEqual([1, 0]);

			finish.resolve();
			await expect(firstTick).resolves.toEqual({
				outcome: "published",
				pendingAgeMs: 0,
			});
		});

		it("releases the session lock when the owning database backend terminates", async () => {
			const capturedPool = new CapturingPool(pool);
			const entered = deferred();
			const finish = deferred();
			const killedHolder = loopWith({
				pool: capturedPool,
				publishPending: async () => {
					entered.resolve();
					await finish.promise;
					return enabledPublication();
				},
			});
			let successorCalls = 0;
			const successor = loopWith({
				publishPending: async () => {
					successorCalls += 1;
					return enabledPublication();
				},
			});

			const killedTick = killedHolder.runOnce();
			await entered.promise;
			const backend = await capturedPool.client?.query<{ pid: number }>(
				"select pg_backend_pid() as pid",
			);
			const processId = backend?.rows[0]?.pid;
			if (!processId) throw new Error("publisher backend id was not captured");
			capturedPool.client?.once("error", () => {});
			await pool.query("select pg_terminate_backend($1)", [processId]);

			await expect(successor.runOnce()).resolves.toEqual({
				outcome: "published",
				pendingAgeMs: 0,
			});
			expect(successorCalls).toBe(1);

			finish.resolve();
			await expect(killedTick).resolves.toMatchObject({ outcome: "error" });
		});
	},
);
