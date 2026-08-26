import { mkdir } from "node:fs/promises";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";

const encoder = new TextEncoder();

export function createResponseStream(
	input: { conversationId: string; model: string; prompt: string },
	options: {
		environment?: Record<string, string | undefined>;
		query?: typeof sdkQuery;
		prepareWorkingDirectory?: (path: string) => Promise<void>;
	} = {},
): ReadableStream<Uint8Array> {
	const query = options.query ?? sdkQuery;
	const prepareWorkingDirectory =
		options.prepareWorkingDirectory ??
		(async (path) => {
			await mkdir(path, { recursive: true });
		});

	const iterator = (async () => {
		const cwd = `/workspace/conversations/${input.conversationId}`;
		await prepareWorkingDirectory(cwd);
		return query({
			prompt: input.prompt,
			options: {
				env: options.environment ?? Bun.env,
				model: input.model,
				includePartialMessages: true,
				cwd,
				permissionMode: "dontAsk",
				persistSession: false,
				settingSources: [],
				thinking: { type: "disabled" },
				tools: [],
			},
		})[Symbol.asyncIterator]();
	})();

	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			const next = await (await iterator).next();
			if (next.done) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
		},
	});
}
