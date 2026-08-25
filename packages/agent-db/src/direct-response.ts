import { and, asc, eq, sql } from "drizzle-orm";
import type { Database, DbTx } from "./client";
import { agentSessions, conversationRuntime, conversations } from "./schema";

type AgentSessionEntry = { uuid?: string; [key: string]: unknown };
type AgentSessionRef = {
	projectKey: string;
	sessionId: string;
	subpath?: string;
};

export interface DirectResponseOwner {
	conversationId: string;
	conversationEpoch: number;
}

export class DirectResponseEpochError extends Error {
	override name = "DirectResponseEpochError" as const;
}

export async function lockDirectResponseEpochTx(
	tx: DbTx,
	owner: DirectResponseOwner,
	operation: string,
): Promise<{ userId: string }> {
	const [conversation] = await tx
		.select({ userId: conversations.userId })
		.from(conversations)
		.where(
			and(
				eq(conversations.conversationId, owner.conversationId),
				eq(conversations.epoch, owner.conversationEpoch),
			),
		)
		.for("share");
	if (!conversation) {
		throw new DirectResponseEpochError(
			`${operation} rejected for stale Conversation epoch`,
		);
	}
	return conversation;
}

export async function appendDirectResponseAgentSessionEntriesTx(
	db: Database,
	input: {
		owner: DirectResponseOwner;
		ref: AgentSessionRef;
		entries: AgentSessionEntry[];
	},
): Promise<void> {
	await db.transaction(async (tx) => {
		await lockDirectResponseEpochTx(tx, input.owner, "session append");
		if (input.entries.length === 0) return;
		await tx
			.insert(agentSessions)
			.values(
				input.entries.map((entry) => ({
					conversationId: input.owner.conversationId,
					epoch: input.owner.conversationEpoch,
					projectKey: input.ref.projectKey,
					sessionId: input.ref.sessionId,
					subpath: input.ref.subpath ?? "",
					uuid: typeof entry.uuid === "string" ? entry.uuid : null,
					entry,
				})),
			)
			.onConflictDoNothing();
	});
}

export async function deleteDirectResponseAgentSessionTx(
	db: Database,
	input: {
		owner: DirectResponseOwner;
		ref: { sessionId: string; subpath?: string };
	},
): Promise<void> {
	await db.transaction(async (tx) => {
		await lockDirectResponseEpochTx(tx, input.owner, "session delete");
		const conditions = [
			eq(agentSessions.conversationId, input.owner.conversationId),
			eq(agentSessions.sessionId, input.ref.sessionId),
		];
		if (input.ref.subpath !== undefined) {
			conditions.push(eq(agentSessions.subpath, input.ref.subpath));
		}
		await tx.delete(agentSessions).where(and(...conditions));
	});
}

export async function loadDirectResponseAgentSessionEntriesTx(
	db: Database,
	input: {
		conversationId: string;
		sessionId: string;
		subpath?: string;
	},
): Promise<AgentSessionEntry[] | null> {
	const rows = await db
		.select({ entry: agentSessions.entry })
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.conversationId, input.conversationId),
				eq(agentSessions.sessionId, input.sessionId),
				eq(agentSessions.subpath, input.subpath ?? ""),
			),
		)
		.orderBy(asc(agentSessions.id));
	return rows.length > 0
		? rows.map((row) => row.entry as AgentSessionEntry)
		: null;
}

export async function listDirectResponseAgentSessionsTx(
	db: Database,
	conversationId: string,
): Promise<Array<{ sessionId: string; mtime: number }>> {
	const rows = await db
		.select({
			sessionId: agentSessions.sessionId,
			mtime: sql<string | Date>`max(${agentSessions.createdAt})`,
		})
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.conversationId, conversationId),
				eq(agentSessions.subpath, ""),
			),
		)
		.groupBy(agentSessions.sessionId);
	return rows.map((row) => ({
		sessionId: row.sessionId,
		mtime: new Date(row.mtime).getTime(),
	}));
}

export async function listDirectResponseAgentSessionSubkeysTx(
	db: Database,
	input: { conversationId: string; sessionId: string },
): Promise<string[]> {
	const rows = await db
		.selectDistinct({ subpath: agentSessions.subpath })
		.from(agentSessions)
		.where(
			and(
				eq(agentSessions.conversationId, input.conversationId),
				eq(agentSessions.sessionId, input.sessionId),
				sql`${agentSessions.subpath} <> ''`,
			),
		);
	return rows.map((row) => row.subpath);
}

export async function loadDirectResponseWorkspaceTx(
	db: Database,
	owner: DirectResponseOwner,
): Promise<{
	userId: string;
	sandboxId: string | null;
	sandboxTainted: boolean;
}> {
	return await db.transaction(async (tx) => {
		const { userId } = await lockDirectResponseEpochTx(
			tx,
			owner,
			"Workspace load",
		);
		const [runtime] = await tx
			.select({
				sandboxId: conversationRuntime.sandboxId,
				sandboxTainted: conversationRuntime.sandboxTainted,
			})
			.from(conversationRuntime)
			.where(
				and(
					eq(conversationRuntime.userId, userId),
					eq(conversationRuntime.conversationId, owner.conversationId),
				),
			);
		return {
			userId,
			sandboxId: runtime?.sandboxId ?? null,
			sandboxTainted: runtime?.sandboxTainted ?? false,
		};
	});
}

export async function publishDirectResponseWorkspaceTx(
	db: Database,
	input: DirectResponseOwner & { userId: string; sandboxId: string },
): Promise<void> {
	await db.transaction(async (tx) => {
		const { userId } = await lockDirectResponseEpochTx(
			tx,
			input,
			"Workspace publication",
		);
		if (userId !== input.userId) {
			throw new DirectResponseEpochError("Workspace owner changed");
		}
		await tx
			.insert(conversationRuntime)
			.values({
				userId,
				conversationId: input.conversationId,
				sandboxId: input.sandboxId,
				sandboxTainted: false,
			})
			.onConflictDoUpdate({
				target: [
					conversationRuntime.userId,
					conversationRuntime.conversationId,
				],
				set: { sandboxId: input.sandboxId, sandboxTainted: false },
			});
	});
}

export async function markDirectResponseWorkspaceTaintedTx(
	db: Database,
	input: DirectResponseOwner & { userId: string },
): Promise<void> {
	await db.transaction(async (tx) => {
		const { userId } = await lockDirectResponseEpochTx(
			tx,
			input,
			"Workspace taint",
		);
		if (userId !== input.userId) {
			throw new DirectResponseEpochError("Workspace owner changed");
		}
		await tx
			.update(conversationRuntime)
			.set({ sandboxTainted: true })
			.where(
				and(
					eq(conversationRuntime.userId, userId),
					eq(conversationRuntime.conversationId, input.conversationId),
				),
			);
	});
}
