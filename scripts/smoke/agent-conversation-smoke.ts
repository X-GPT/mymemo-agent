#!/usr/bin/env bun

const baseUrl = requiredEnv("AGENT_SMOKE_BASE_URL").replace(/\/+$/, "");
const memberCode = Bun.env.AGENT_SMOKE_MEMBER_CODE || "agent-smoke-member";
const partnerCode = Bun.env.AGENT_SMOKE_PARTNER_CODE || "agent-smoke-partner";
const expectGateClosed = Bun.env.AGENT_SMOKE_EXPECT_GATE_CLOSED !== "false";

function requiredEnv(name: string): string {
	const value = Bun.env[name];
	if (!value) throw new Error(`${name} is required`);
	return value;
}

function headers(): HeadersInit {
	return {
		"Content-Type": "application/json",
		"X-Member-Code": memberCode,
		"X-Partner-Code": partnerCode,
	};
}

const create = await fetch(`${baseUrl}/v1/conversations`, {
	method: "POST",
	headers: headers(),
	body: "{}",
});

if (expectGateClosed) {
	if (create.status !== 403) {
		throw new Error(
			`expected Statsig gate to be closed with 403, got ${create.status}`,
		);
	}
	console.log("agent smoke passed: Statsig gate is closed by default");
	process.exit(0);
}

if (create.status !== 201) {
	throw new Error(
		`expected conversation create 201, got ${create.status}: ${await create.text()}`,
	);
}

const { conversationId } = (await create.json()) as { conversationId?: string };
if (!conversationId)
	throw new Error(
		"conversation create response did not include conversationId",
	);

const event = await fetch(
	`${baseUrl}/v1/conversations/${conversationId}/events`,
	{
		method: "POST",
		headers: headers(),
		body: JSON.stringify({
			type: "user.message",
			text: "Smoke test: reply with a short acknowledgement.",
		}),
	},
);

if (!event.ok) {
	throw new Error(
		`expected event stream 2xx, got ${event.status}: ${await event.text()}`,
	);
}

const body = await event.text();
if (!body.includes("event: done") && !body.includes("event: text_delta")) {
	throw new Error("event stream did not include expected SSE frames");
}

console.log("agent smoke passed: conversation stream responded");
