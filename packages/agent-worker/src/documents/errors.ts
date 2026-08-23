/**
 * Errors the document query client exposes to callers (ultimately the model
 * via MCP tool results). Messages on both classes are bounded and
 * model-readable by construction: they are fixed strings chosen here, never
 * driver error text, SQL, or connection strings — those stay in the worker
 * log. Tool layers may surface `.message` verbatim.
 */

/**
 * The frozen conversation scope rejected the access (out-of-scope document,
 * malformed persisted scope). Deliberately uniform for unknown vs. out-of-scope
 * document ids so the error never leaks document existence across scopes.
 */
export class DocumentScopeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentScopeError";
	}
}

/** KB or audit-ledger infrastructure failure, reduced to a safe fixed string. */
export class DocumentQueryError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DocumentQueryError";
	}
}
