import { type HistoryStore, type Turn, turnMetadata } from "./history";
import { type InvokeRuntime, sdkMessages } from "./runtime";
import { type ConversationStore, SendConflict } from "./store";
import { createTextStream, type TextStreamChunk } from "./text-stream";

export class Messages {
	readonly pending = new Set<Promise<void>>();
	constructor(
		readonly store: ConversationStore,
		readonly history: HistoryStore,
		readonly invoke: InvokeRuntime,
	) {}
	async send(id: string, userId: string, text: string, requestId: string) {
		let admitted: Awaited<ReturnType<ConversationStore["admit"]>>;
		try {
			admitted = await this.store.admit(id, userId, text, requestId);
		} catch (error) {
			if (!(error instanceof SendConflict)) throw error;
			if (error.code !== "duplicate_request")
				return Response.json({ error: error.code }, { status: 409 });
			const request = error.request;
			if (!request) throw error;
			const turn = await this.history.get(id, request.seq);
			const conversation = await this.store.get(id, userId);
			const status = turn
				? turnMetadata(turn, conversation).status
				: conversation.processing?.turnId === request.turnId
					? "processing"
					: "error";
			return Response.json(
				{ error: error.code, turnId: request.turnId, status },
				{ status: 409 },
			);
		}
		const { conversation, turnId, seq, startedAt, until } = admitted;
		const metadata = {
			turnId,
			requestId,
			status: "processing" as const,
			startedAt,
		};
		const turn: Turn = {
			...metadata,
			seq,
			user: {
				id: `u_${turnId}`,
				role: "user",
				parts: [{ type: "text", text }],
				metadata,
			},
			assistant: null,
		};
		// A failed initial write must never invoke a Turn whose user message is absent.
		await this.history.put(id, turn);
		const encoder = new TextEncoder();
		let disconnected = false;
		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				const emit = (chunk: TextStreamChunk) => {
					if (!disconnected)
						controller.enqueue(
							encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`),
						);
				};
				const terminal: TextStreamChunk[] = [];
				const converter = createTextStream({
					messageId: crypto.randomUUID(),
					...metadata,
					emit: (chunk) => {
						if (
							chunk.type === "message-metadata" ||
							chunk.type === "finish" ||
							chunk.type === "error"
						)
							terminal.push(chunk);
						else emit(chunk);
					},
				});
				const run = async () => {
					let failure: string | undefined;
					try {
						const raw = await this.invoke({
							conversationId: id,
							turnId,
							seq,
							requestId,
							userId,
							scope: conversation.scope,
							text,
							startedAt: Date.parse(startedAt),
							budgetUntil: Date.parse(until),
							sandboxSessionId: "unused-no-tools",
						});
						for await (const message of sdkMessages(raw))
							converter.push(message);
					} catch {
						failure = "internal_error";
					}
					turn.assistant = converter.finish(failure);
					Object.assign(turn, turn.assistant.metadata);
					turn.user.metadata = turn.assistant.metadata;
					await this.history.put(id, turn);
					await this.store.clearProcessing(id, turnId);
					for (const chunk of terminal) emit(chunk);
					if (!disconnected) {
						controller.enqueue(encoder.encode("data: [DONE]\n\n"));
						controller.close();
					}
				};
				// Keep draining on browser reload; the Lambda response remains open until persistence.
				const pending = run().catch((error) => {
					console.error({
						message: "Turn persistence failed",
						name: error instanceof Error ? error.name : "Error",
					});
					if (!disconnected) controller.error(error);
				});
				this.pending.add(pending);
				void pending.finally(() => this.pending.delete(pending));
			},
			cancel() {
				disconnected = true;
			},
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream",
				"x-vercel-ai-ui-message-stream": "v1",
				"cache-control": "no-cache",
				"x-accel-buffering": "no",
			},
		});
	}
}
