import { createClient } from "redis";
import { createResumableStreamContext } from "resumable-stream";

export function createAiChatResumableStreams(redisUrl: string) {
	let publisher: ReturnType<typeof createClient> | undefined;
	let subscriber: ReturnType<typeof createClient> | undefined;
	let context:
		| Promise<ReturnType<typeof createResumableStreamContext>>
		| undefined;
	const getContext = () => {
		context ??= (async () => {
			publisher = createClient({ url: redisUrl });
			subscriber = createClient({ url: redisUrl });
			publisher.on("error", () => {});
			subscriber.on("error", () => {});
			await Promise.all([publisher.connect(), subscriber.connect()]);
			return createResumableStreamContext({
				keyPrefix: "mymemo:ai-chat",
				waitUntil: null,
				publisher,
				subscriber,
			});
		})();
		return context;
	};
	return {
		async create(streamId: string, stream: ReadableStream<string>) {
			await (await getContext()).createNewResumableStream(
				streamId,
				() => stream,
			);
		},
		async resume(streamId: string) {
			try {
				return await (await getContext()).resumeExistingStream(streamId);
			} catch (error) {
				// resumable-stream uses this ack timeout when its Redis sentinel
				// survived the producer. Redis itself is healthy; the stream is gone.
				if (
					error instanceof Error &&
					error.message === "Timeout waiting for ack"
				) {
					return undefined;
				}
				throw error;
			}
		},
		close() {
			publisher?.destroy();
			subscriber?.destroy();
		},
	};
}
