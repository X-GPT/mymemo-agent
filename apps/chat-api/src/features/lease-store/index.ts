import type { Database } from "@/db/client";
import type { LeaseStore } from "./lease-store";
import { PostgresLeaseStore } from "./postgres-lease-store";

export type { LeaseRecord, LeaseRef, LeaseStore } from "./lease-store";
export { PostgresLeaseStore } from "./postgres-lease-store";

/**
 * Build the lease store over the shared writable-DB connection. The Postgres-
 * backed lease registry is only consumed once sandbox leasing is wired into the
 * turn path (Task 14); it reuses the `Database` built in `createDeps` rather than
 * opening its own pool.
 */
export function createLeaseStore(database: Database): LeaseStore {
	return new PostgresLeaseStore(database);
}
