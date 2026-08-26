import { expect, it } from "bun:test";
import type {
	Options,
	query,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { createResponseStream } from "./response-execution";

it("runs a fresh no-tool query and streams raw SDK messages", async () => {
	const message = {
		type: "system",
		subtype: "init",
		session_id: "session-1",
	} as SDKMessage;
	let queryOptions: Options | undefined;
	const body = createResponseStream(
		{
			conversationId: "conversation-1",
			model: "anthropic/claude-sonnet-5",
			prompt: "hello",
		},
		{
			environment: { PATH: "/usr/bin", ANTHROPIC_AUTH_TOKEN: "secret" },
			prepareWorkingDirectory: async () => {},
			query: ((input: { options: Options }) => {
				queryOptions = input.options;
				return (async function* () {
					yield message;
				})();
			}) as unknown as typeof query,
		},
	);

	expect(await new Response(body).text()).toBe(`${JSON.stringify(message)}\n`);
	expect(queryOptions?.persistSession).toBe(false);
	expect(queryOptions?.model).toBe("anthropic/claude-sonnet-5");
	expect(queryOptions?.tools).toEqual([]);
	expect(queryOptions?.env).toEqual({
		PATH: "/usr/bin",
		ANTHROPIC_AUTH_TOKEN: "secret",
	});
});
