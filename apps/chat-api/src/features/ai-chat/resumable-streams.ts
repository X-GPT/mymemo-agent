import { createResumableStreamContext } from "resumable-stream";

type Context = ReturnType<typeof createResumableStreamContext>;

export function createAiChatResumableStreams(context?: Context) {
	const getContext = () => {
		context ??= createResumableStreamContext({
			keyPrefix: "mymemo:ai-chat",
			waitUntil: null,
		});
		return context;
	};
	return {
		async create(streamId: string, stream: ReadableStream<string>) {
			await getContext().createNewResumableStream(streamId, () => stream);
		},
		resume: (streamId: string) => getContext().resumeExistingStream(streamId),
	};
}
