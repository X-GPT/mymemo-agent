import { expect, it } from "bun:test";
import {
	createResponseInvocationHandler,
	type ResponseInvocation,
} from "./server";

const invocation: ResponseInvocation = {
	conversationId: "conversation-1",
	model: "anthropic/claude-sonnet-5",
	prompt: "hello",
};
const body = JSON.stringify({
	model: invocation.model,
	prompt: invocation.prompt,
});

function request(
	requestBody = body,
	runtimeSessionId: string | null = "conversation-1",
	contentType = "application/json",
): Request {
	return new Request("http://runtime/invocations", {
		method: "POST",
		headers: {
			"content-type": contentType,
			...(runtimeSessionId === null
				? {}
				: { "x-amzn-bedrock-agentcore-runtime-session-id": runtimeSessionId }),
		},
		body: requestBody,
	});
}

it("accepts only a valid request bound to the AgentCore Runtime session", async () => {
	const invoked: ResponseInvocation[] = [];
	const handler = createResponseInvocationHandler((input) => {
		invoked.push(input);
		return new Blob(['{"type":"result"}\n']).stream();
	});
	const response = await handler(request());
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("application/x-ndjson");
	expect(await response.text()).toBe('{"type":"result"}\n');
	expect(invoked).toEqual([invocation]);

	expect((await handler(request(body, "invalid/session"))).status).toBe(400);
	expect(invoked).toEqual([invocation]);
});

it("rejects invalid invocations before dispatch and hides dispatch failures", async () => {
	let invocations = 0;
	const handler = createResponseInvocationHandler(() => {
		invocations++;
		throw new Error("internal failure");
	});
	expect(
		(await handler(request(body, "conversation-1", "text/plain"))).status,
	).toBe(415);
	expect((await handler(request("not json"))).status).toBe(400);
	expect((await handler(request("{}"))).status).toBe(400);
	expect(
		(
			await handler(
				request(JSON.stringify({ model: "unsupported", prompt: "hello" })),
			)
		).status,
	).toBe(400);
	expect((await handler(request(body, null))).status).toBe(400);
	expect(invocations).toBe(0);
	expect((await handler(request(body))).status).toBe(503);
	expect(invocations).toBe(1);
});
