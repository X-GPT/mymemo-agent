// PROBE — throwaway. A fake Anthropic-Messages endpoint so the SDK→MCP→hand mechanics can be
// exercised with NO model key: turn 1 emits a tool_use for mcp__hand__bash (`npm test`), turn 2
// a tool_use for mcp__hand__edit (fix the bug), turn 3 bash again, then end_turn with text.
// Usage: bun run fake-model.ts  (listens on :8787); ANTHROPIC_BASE_URL=http://localhost:8787
let n = 0;
const steps: Array<{ tool?: string; input?: unknown; text?: string }> = [
	{ tool: "mcp__hand__bash", input: { command: "npm test" } },
	{ tool: "mcp__hand__edit", input: { path: "math.js", old: "return a - b;", new: "return a + b;" } },
	{ tool: "mcp__hand__bash", input: { command: "npm test" } },
	{ text: "Fixed add() in math.js (was subtracting); tests pass." },
];
const sse = (events: Array<[string, unknown]>) => new Response(new ReadableStream({ start(c) { const e = new TextEncoder(); for (const [ev, d] of events) c.enqueue(e.encode(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`)); c.close(); } }), { headers: { "content-type": "text/event-stream" } });
Bun.serve({ port: 8787, async fetch(req) {
	if (!req.url.includes("/messages")) return new Response("nope", { status: 404 });
	const body = await req.json() as any;
	const toolsSeen = (body.tools ?? []).map((t: any) => t.name);
	const step = steps[Math.min(n++, steps.length - 1)];
	const id = `msg_${n}`;
	if (step.tool) return sse([
		["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${n}`, name: (process.env.FAKE_ALIAS || !toolsSeen.includes(step.tool)) ? step.tool.replace("mcp__hand__", "").replace(/^\w/, (c: string) => c.toUpperCase()) : step.tool, input: {} } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(step.input) } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } }],
		["message_stop", { type: "message_stop" }],
	]);
	return sse([
		["message_start", { type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
		["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
		["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } }],
		["content_block_stop", { type: "content_block_stop", index: 0 }],
		["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } }],
		["message_stop", { type: "message_stop" }],
	]);
} });
console.log("fake model on :8787");
