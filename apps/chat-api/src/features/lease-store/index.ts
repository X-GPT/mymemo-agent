import type { ApiConfig } from "@/config/env";
import { createDatabase } from "@/db/client";
import type { LeaseStore } from "./lease-store";
import { PostgresLeaseStore } from "./postgres-lease-store";

export type { LeaseRecord, LeaseRef, LeaseStore } from "./lease-store";
export { PostgresLeaseStore } from "./postgres-lease-store";

/**
 * Build the lease store from config, or `null` when chat-api has no database
 * configured. The Postgres-backed lease registry is only consumed once sandbox
 * leasing is wired into the turn path (Task 14), so it is optional today: a
 * deployment without `DATABASE_URL` keeps the per-turn create/kill behavior.
 */
export function createLeaseStore(config: ApiConfig): LeaseStore | null {
	if (!config.databaseUrl) return null;
	return new PostgresLeaseStore(createDatabase(config.databaseUrl));
}
