import { randomUUID } from "node:crypto";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Database } from "@mymemo/agent-db/client";
import {
	claimNextTurnTx,
	type TurnOutcome,
	terminalizeTurnTx,
	upsertAssistantMessageTx,
} from "@mymemo/agent-db/turn-store";
import type { TurnLiveStreamRelay } from "@mymemo/live-text";
import type { UIMessageChunk } from "ai";
import {
	TurnStreamMapper,
	TurnStreamProtocolError,
	type TurnUIMessagePart,
} from "./turn-stream-mapper";

/**
 * Serve one Turn (spec #654, ticket #662): claim the Conversation's next
 * queued Turn — the DB itself gates one-in-flight, which is what makes the
 * nudge idempotent — run one SDK `query()` under the confinement bundle, keep
 * the Turn's single assistant UIMessage row current at every Step's completion
 * boundary (commit BEFORE the Step's completion chunk publishes), and
 * terminalize the Turn with its Outcome before the terminal chunk publishes.
 *
 * Relay publishes are best-effort: a Live Stream failure degrades live
 * delivery but never changes durable Turn execution (the v1 stance, carried
 * forward) — a disconnected reader Recovers from durable history.
 */

/** The SDK `query()` call as a seam: production passes the real function,
 * tests a fake that yields a scripted stream. */
export type TurnQueryFn = (params: {
	prompt: string;
	options: Options;
}) => AsyncIterable<SDKMessage>;

export interface TurnLogger {
	warn(payload: object, message?: string): void;
	error(payload: object, message?: string): void;
}

export interface TurnServingDeps {
	db: Database;
	relay: TurnLiveStreamRelay;
	userId: string;
	conversationId: string;
	query: TurnQueryFn;
	/** The confinement bundle — static per VM (one Conversation, one cwd). */
	queryOptions: Options;
	logger: TurnLogger;
}

/** Extract the prompt from the Turn's stored user UIMessage parts. */
export function promptFromParts(parts: unknown): string {
	if (!Array.isArray(parts)) return "";
	return parts
		.filter(
			(part): part is { type: "text"; text: string } =>
				typeof part === "object" &&
				part !== null &&
				(part as { type?: unknown }).type === "text" &&
				typeof (part as { text?: unknown }).text === "string",
		)
		.map((part) => part.text)
		.join("\n\n");
}

/**
 * Claim and serve the next queued Turn. Returns the Turn's Outcome, or null
 * when there was nothing to claim (nothing queued, or a Turn already in
 * flight — the idempotent-nudge no-op).
 */
export async function serveOneTurn(
	deps: TurnServingDeps,
): Promise<TurnOutcome | null> {
	const { db, logger, userId, conversationId } = deps;
	const claimed = await claimNextTurnTx(db, { userId, conversationId });
	if (!claimed) return null;

	const turnKey = { userId, conversationId, messageId: claimed.messageId };
	const assistantMessageId = randomUUID();
	const publisher = deps.relay.openPublisher(claimed.messageId);
	const publish = async (chunk: UIMessageChunk): Promise<void> => {
		try {
			await publisher.publish(chunk);
		} catch (error) {
			logger.warn(
				{ ...turnKey, chunkType: chunk.type, error: toMessage(error) },
				"Live Stream publish failed; durable execution continues",
			);
		}
	};
	const upsert = (parts: TurnUIMessagePart[]): Promise<void> =>
		upsertAssistantMessageTx(db, {
			userId,
			conversationId,
			messageId: assistantMessageId,
			parts,
		});

	const mapper = new TurnStreamMapper();
	try {
		await publish({ type: "start", messageId: assistantMessageId });
		const prompt = promptFromParts(claimed.parts);
		if (prompt.length === 0) {
			throw new TurnStreamProtocolError("Turn has no text parts to prompt");
		}
		let outcome: TurnOutcome | null = null;
		for await (const message of deps.query({
			prompt,
			options: deps.queryOptions,
		})) {
			for (const action of mapper.accept(message)) {
				if (action.kind === "chunk") {
					await publish(action.chunk);
				} else if (action.kind === "step-commit") {
					// Commit-before-publish per Step: the row upserts with the
					// Step's parts BEFORE the Step's completion chunk publishes.
					await upsert(action.parts);
					await publish({ type: "finish-step" });
				} else {
					// The terminal chunk publishes only after the final upsert
					// and the status flip.
					if (action.parts.length > 0) await upsert(action.parts);
					await terminalize(deps, turnKey, action.outcome);
					await publish(action.chunk);
					outcome = action.outcome;
				}
			}
		}
		if (outcome === null) {
			throw new TurnStreamProtocolError("SDK stream ended without a result");
		}
		return outcome;
	} catch (error) {
		logger.error(
			{ ...turnKey, error: toMessage(error) },
			"Turn failed; terminalizing error with the completed Steps retained",
		);
		// Retain exactly the completed Steps — a Step in flight is never
		// persisted, and no content is fabricated.
		const parts = mapper.committedParts;
		try {
			if (parts.length > 0) await upsert(parts);
			await terminalize(deps, turnKey, "error");
		} catch (persistError) {
			// The status flip failed, so no terminal chunk may publish;
			// publisher.close() below signals the reader to Recover from
			// durable history instead.
			logger.error(
				{ ...turnKey, error: toMessage(persistError) },
				"could not terminalize the failed Turn",
			);
			return "error";
		}
		await publish({ type: "error", errorText: "The Turn ended in error." });
		return "error";
	} finally {
		await publisher.close().catch(() => {});
	}
}

async function terminalize(
	deps: TurnServingDeps,
	turnKey: { userId: string; conversationId: string; messageId: string },
	outcome: TurnOutcome,
): Promise<void> {
	const flipped = await terminalizeTurnTx(deps.db, { ...turnKey, outcome });
	if (!flipped) {
		// The from-status guard refused: the Turn already reached an Outcome.
		// At-most-once holds; report it rather than overwrite.
		deps.logger.error(
			{ ...turnKey, outcome },
			"Turn was already terminal; outcome not overwritten",
		);
	}
}

function toMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
