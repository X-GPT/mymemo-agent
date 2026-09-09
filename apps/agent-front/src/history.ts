import {
	GetObjectCommand,
	PutObjectCommand,
	type S3Client,
} from "@aws-sdk/client-s3";
import { deletePrefix } from "./cleanup";
import type { Conversation } from "./store";
import type { AssistantMessage, MessageMetadata } from "./text-stream";

export interface Turn extends MessageMetadata {
	seq: number;
	user: {
		id: string;
		role: "user";
		parts: { type: "text"; text: string }[];
		metadata: MessageMetadata;
	};
	assistant: AssistantMessage | null;
}
const key = (id: string, seq: number) =>
	`_history/${id}/turn-${String(seq).padStart(6, "0")}.json`;
export class HistoryStore {
	constructor(
		readonly s3: S3Client,
		readonly bucket: string,
	) {}
	async put(id: string, turn: Turn) {
		await this.s3.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: key(id, turn.seq),
				Body: JSON.stringify(turn),
				ContentType: "application/json",
			}),
		);
	}
	async get(id: string, seq: number): Promise<Turn | undefined> {
		try {
			const object = await this.s3.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: key(id, seq) }),
			);
			if (!object.Body) throw new Error("History object has no body");
			return JSON.parse(await object.Body.transformToString()) as Turn;
		} catch (error) {
			if (error instanceof Error && error.name === "NoSuchKey") return;
			throw error;
		}
	}
	async page(conversation: Conversation, limit: number, cursor?: number) {
		const messages: Array<Turn["user"] | AssistantMessage> = [];
		let seq = Math.min(
			conversation.turnCount,
			cursor === undefined ? conversation.turnCount : cursor - 1,
		);
		let count = 0;
		while (seq > 0 && count < limit) {
			const turn = await this.get(conversation.conversationId, seq--);
			if (!turn) continue; // Admission can win immediately before its initial S3 write.
			const metadata = turnMetadata(turn, conversation);
			messages.push({ ...turn.user, metadata });
			if (turn.assistant) messages.push({ ...turn.assistant, metadata });
			count++;
		}
		return { messages, nextCursor: seq > 0 ? String(seq + 1) : null };
	}
	async delete(id: string) {
		await deletePrefix(this.s3, this.bucket, `_history/${id}/`);
	}
}
export function turnMetadata(
	turn: MessageMetadata,
	conversation: Conversation,
): MessageMetadata {
	const {
		turnId,
		requestId,
		status,
		startedAt,
		endedAt,
		errorCode,
		modelUsage,
	} = turn;
	return {
		turnId,
		requestId,
		status,
		startedAt,
		...(endedAt ? { endedAt } : {}),
		...(errorCode ? { errorCode } : {}),
		...(modelUsage ? { modelUsage } : {}),
		...(status === "processing" && conversation.processing?.turnId !== turnId
			? { status: "error", errorCode: "abandoned" }
			: {}),
	};
}
