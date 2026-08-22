#!/usr/bin/env bun

const baseUrl = (
	Bun.env.AGENT_SMOKE_BASE_URL ?? "http://127.0.0.1:3000"
).replace(/\/+$/, "");

const deadline = Date.now() + 60_000;
while (true) {
	try {
		if ((await fetch(`${baseUrl}/health`)).ok) break;
	} catch {}
	if (Date.now() >= deadline)
		throw new Error("local Chat API did not become healthy");
	await Bun.sleep(250);
}

Object.assign(Bun.env, {
	AGENT_SMOKE_BASE_URL: baseUrl,
	AGENT_SMOKE_MEMBER_CODE: "demo-member",
	AGENT_SMOKE_PARTNER_CODE: "local-development",
	AGENT_SMOKE_EXPECT_GATE_CLOSED: "false",
	AGENT_SMOKE_EXPECT_EXECUTION_RUNTIME: "agentcore",
	AGENT_SMOKE_SUITE: "full",
});

await import("./agent-conversation-smoke");
