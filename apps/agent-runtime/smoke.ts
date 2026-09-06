// Run against the image with OPENROUTER_API_KEY set in its environment.
const now = Date.now();
const response = await fetch(
	`${process.env.RUNTIME_URL ?? "http://localhost:8080"}/invocations`,
	{
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			conversationId: crypto.randomUUID(),
			turnId: crypto.randomUUID(),
			seq: 1,
			requestId: crypto.randomUUID(),
			userId: "runtime-smoke",
			scope: { kind: "general" },
			text: "Reply with exactly: runtime smoke ok",
			startedAt: now,
			budgetUntil: now + 720_000,
			sandboxSessionId: "unused-no-tools",
		}),
		signal: AbortSignal.timeout(120_000),
	},
);
if (!response.ok) throw new Error(`Runtime returned ${response.status}`);
const messages = (await response.text())
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
const result = messages.at(-1);
if (
	result?.type !== "result" ||
	result.is_error ||
	!String(result.result).includes("runtime smoke ok")
) {
	throw new Error(`Smoke failed: ${JSON.stringify(result)}`);
}
console.log(
	JSON.stringify({
		types: [...new Set(messages.map((m) => m.type))],
		lines: messages.length,
		result: result.subtype,
	}),
);
