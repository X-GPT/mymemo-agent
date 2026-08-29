import type { Database } from "@mymemo/agent-db/client";
import { documentAccessEvents } from "@mymemo/agent-db/schema";

/** One `document_access_events` row: a list, search, or load on this path. */
export interface DocumentAccessEvent {
	/** Stored in `run_id`: the Harness turn id (a Run id on the Run path). */
	turnId: string;
	conversationId: string;
	userId: string;
	operation: "list" | "search" | "load";
	scopeType: "general" | "collection" | "document";
	scopeId: string | null;
	/** Search query; null for list and load. */
	query: string | null;
	documentIds: string[];
	resultCount: number;
}

export interface DocumentAccessLog {
	record(event: DocumentAccessEvent): Promise<void>;
}

/** Appends through chat-api's writable agent-DB connection. */
export class PostgresDocumentAccessLog implements DocumentAccessLog {
	constructor(private readonly db: Database) {}

	async record({ turnId, ...event }: DocumentAccessEvent): Promise<void> {
		await this.db
			.insert(documentAccessEvents)
			.values({ runId: turnId, ...event });
	}
}
