import { Pool } from "pg";

/**
 * Minimal data-access seam for the document module. Parameterized SQL only —
 * every caller passes a positional-param query, so query logic is unit-tested
 * with a fake Db and never needs a live Postgres. Only named query functions
 * are exported from this module's siblings; a Db handle is never passed into
 * MCP/tool code.
 */
export interface Db {
	query<T = Record<string, unknown>>(
		text: string,
		params?: unknown[],
	): Promise<T[]>;
}

// Design-mandated query bounds: a runaway KB query is cut server-side, and a
// dead connection cannot hang a run past the client-side deadline.
const STATEMENT_TIMEOUT_MS = 5_000;
const QUERY_TIMEOUT_MS = 10_000;

function createPgDb(connectionString: string, max: number): Db {
	const pool = new Pool({
		connectionString,
		max,
		statement_timeout: STATEMENT_TIMEOUT_MS,
		query_timeout: QUERY_TIMEOUT_MS,
	});
	return {
		query: async <T>(text: string, params: unknown[] = []) =>
			(await pool.query(text, params)).rows as T[],
	};
}

/**
 * The read-only KB connection (`mymemo_kb`). Refusing an empty URL here is the
 * document-search startup guard: the module cannot be constructed without the
 * KB credential, independent of the entrypoint's env validation.
 */
export function createKbDb(kbDatabaseUrl: string): Db {
	if (!kbDatabaseUrl) {
		throw new Error("KB_DATABASE_URL is required to start document search");
	}
	return createPgDb(kbDatabaseUrl, 4);
}

/**
 * The writable agent connection (`mymemo_agent`) backing the
 * `document_access_events` audit ledger. Kept a separate named client from the
 * KB — the two trust domains never share a handle.
 */
export function createAgentDb(agentDatabaseUrl: string): Db {
	if (!agentDatabaseUrl) {
		throw new Error(
			"AGENT_DATABASE_URL is required to start document search (audit ledger)",
		);
	}
	return createPgDb(agentDatabaseUrl, 4);
}
