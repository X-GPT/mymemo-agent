import { createResumableStreamContext } from "resumable-stream";

type Context = ReturnType<typeof createResumableStreamContext>;

export function createAiChatResumableStreams(
	createContext: () => Context = () =>
		createResumableStreamContext({
			keyPrefix: "mymemo:ai-chat",
			waitUntil: null,
		}),
) {
	let context: Context | undefined;
	const run = async <T>(operation: (value: Context) => Promise<T>) => {
		context ??= createContext();
		try {
			return await operation(context);
		} catch (error) {
			context = undefined;
			throw error;
		}
	};
	return {
		async create(streamId: string, stream: ReadableStream<string>) {
			const created = await run((value) =>
				value.createNewResumableStream(streamId, () => stream),
			);
			if (!created) throw new Error("resumable stream id already completed");
		},
		resume: (streamId: string) =>
			run((value) => value.resumeExistingStream(streamId)),
	};
}
