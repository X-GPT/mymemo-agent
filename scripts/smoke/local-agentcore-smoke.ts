#!/usr/bin/env bun

import { readClientContractSse } from "./client-contract";

const baseUrl = (
	Bun.env.AGENT_SMOKE_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");
const headers = {
	"content-type": "application/json",
	"x-member-code": "local-agentcore-smoke",
	"x-partner-code": "local-development",
};

const deadline = Date.now() + 60_000;
while (true) {
	try {
		if ((await fetch(`${baseUrl}/health`)).ok) break;
	} catch {}
	if (Date.now() >= deadline)
		throw new Error("local Chat API did not become healthy");
	await Bun.sleep(250);
}

const create = await fetch(`${baseUrl}/v1/conversations`, {
	method: "POST",
	headers,
	body: "{}",
});
if (create.status !== 201) {
	throw new Error(
		`local Conversation creation returned ${create.status}: ${await create.text()}`,
	);
}
const conversation = (await create.json()) as {
	conversationId?: string;
	executionRuntime?: string;
};
if (
	!conversation.conversationId ||
	conversation.executionRuntime !== "agentcore"
) {
	throw new Error("local Conversation creation did not select AgentCore");
}

const runId = crypto.randomUUID();
const run = await fetch(
	`${baseUrl}/v1/conversations/${conversation.conversationId}/runs`,
	{
		method: "POST",
		headers,
		body: JSON.stringify({
			threadId: conversation.conversationId,
			runId,
			messages: [
				{
					id: crypto.randomUUID(),
					role: "user",
					content: "Reply with exactly LOCAL_AGENTCORE_OK and nothing else.",
				},
			],
			tools: [],
			context: [],
		}),
		signal: AbortSignal.timeout(180_000),
	},
);
const events = await run.text();
if (!run.ok) {
	throw new Error(`local Run returned ${run.status}: ${events}`);
}
const snapshot = readClientContractSse(events);
if (
	snapshot.terminal !== "done" ||
	snapshot.messages.length !== 1 ||
	snapshot.messages[0]?.provisional ||
	snapshot.messages[0]?.text !== "LOCAL_AGENTCORE_OK"
) {
	throw new Error("local Run did not complete through the AgentCore Runtime");
}

console.log(
	`local AgentCore smoke passed: conversation ${conversation.conversationId}; run ${runId}`,
);
