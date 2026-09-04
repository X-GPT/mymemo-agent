// PROBE — throwaway (wayfinder #708). The v3 Agent Runner in miniature: a real `query()` whose
// only tools are an in-process MCP "hand" server calling the Sandbox. Built-ins are off
// (`tools: []`), `toolAliases` routes model-emitted Bash/Read/... to the hand, permission is a
// `dontAsk` allowlist. Model: whatever ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN point at
// (OpenRouter's Anthropic-compatible endpoint, or ./fake-model.ts for mechanics-only runs).
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { hand, calls } from "./hand-client";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const CAP_CHARS = 60_000; // keep every tool result well under the SDK's 25k-token spill-to-file path
const clip = (s: string) => (s.length > CAP_CHARS ? s.slice(0, CAP_CHARS) + `\n…[truncated ${s.length - CAP_CHARS} chars by the Runner]` : s);
const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: clip(t) }], ...(isError ? { isError: true } : {}) });

const handServer = createSdkMcpServer({
	name: "hand",
	version: "0.0.1",
	tools: [
		tool("bash", "Run a shell command in the workspace sandbox. Returns stdout, stderr and the exit code.", { command: z.string(), timeoutMs: z.number().optional() },
			async ({ command, timeoutMs }) => { const r = await hand("bash", { command, timeoutMs: timeoutMs ?? 120_000 }); return text(`exit ${r.exitCode}${r.timedOut ? " (timed out)" : ""}${r.truncated ? " (output truncated)" : ""}\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`, r.exitCode !== 0); }, { alwaysLoad: true }),
		tool("read", "Read a file in the workspace (path relative to the workspace root).", { path: z.string(), offset: z.number().optional(), limit: z.number().optional() },
			async (a) => { const r = await hand("read", a); return text(r.text); }, { alwaysLoad: true }),
		tool("write", "Create or overwrite a file in the workspace.", { path: z.string(), content: z.string() },
			async (a) => { await hand("write", a); return text(`wrote ${a.path}`); }, { alwaysLoad: true }),
		tool("edit", "Replace an exact string in a file. old must match exactly once unless replaceAll.", { path: z.string(), old: z.string(), new: z.string(), replaceAll: z.boolean().optional() },
			async (a) => { try { const r = await hand("edit", a); return text(`edited ${a.path} (${r.replaced} replacement)`); } catch (e) { return text(String((e as Error).message), true); } }, { alwaysLoad: true }),
		tool("glob", "List workspace files matching a glob pattern.", { pattern: z.string() },
			async (a) => { const r = await hand("glob", a); return text(r.files.join("\n") || "(no matches)"); }, { alwaysLoad: true }),
		tool("grep", "Search workspace files for a regex. Returns file:line:match lines.", { pattern: z.string(), glob: z.string().optional() },
			async (a) => { const r = await hand("grep", a); return text(r.matches || "(no matches)"); }, { alwaysLoad: true }),
	],
});

function claudeExecutable(): string {
	const require = createRequire(import.meta.url);
	const sdkEntry = require.resolve("@anthropic-ai/claude-agent-sdk");
	return require.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`, { paths: [dirname(sdkEntry)] });
}

const prompt = process.argv[2] ?? "Run the test suite with `npm test`. If anything fails, find the bug in the source (not the test), fix it with the edit tool, and run the tests again until they pass. Report what you changed.";
const t0 = performance.now();
const log: string[] = [];
const q = query({
	prompt,
	options: {
		cwd: process.env.RUNNER_CWD ?? process.cwd(),
		pathToClaudeCodeExecutable: claudeExecutable(),
		settingSources: [],
		strictMcpConfig: true,
		tools: [],
		toolAliases: { Bash: "mcp__hand__bash", Read: "mcp__hand__read", Write: "mcp__hand__write", Edit: "mcp__hand__edit", Glob: "mcp__hand__glob", Grep: "mcp__hand__grep" },
		mcpServers: { hand: handServer },
		allowedTools: ["mcp__hand__*"],
		disallowedTools: ["Bash", "BashOutput", "KillShell", "TaskOutput", "TaskStop", "WebFetch", "WebSearch", "Read", "Write", "Edit", "Glob", "Grep"],
		permissionMode: "dontAsk",
		model: process.env.MODEL ?? "anthropic/claude-sonnet-4.5",
		maxTurns: 12,
		env: { PATH: process.env.PATH!, HOME: process.env.HOME!, ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL!, ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN ?? "probe", ANTHROPIC_API_KEY: "", CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
	},
});
for await (const m of q) {
	const t = Math.round(performance.now() - t0);
	if (m.type === "assistant") for (const b of (m.message as any).content ?? []) { if (b.type === "tool_use") log.push(`${t}ms tool_use ${b.name} ${JSON.stringify(b.input).slice(0, 200)}`); else if (b.type === "text") log.push(`${t}ms assistant: ${String(b.text).slice(0, 300).replace(/\n/g, " ")}`); }
	else if (m.type === "user") for (const b of (m.message as any).content ?? []) { if (b.type === "tool_result") log.push(`${t}ms tool_result ${b.is_error ? "ERROR " : ""}${JSON.stringify(b.content).slice(0, 200)}`); }
	else if (m.type === "result") log.push(`${t}ms result ${m.subtype} turns=${(m as any).num_turns} cost=${(m as any).total_cost_usd}`);
	else if (m.type === "system") log.push(`${t}ms system:${(m as any).subtype} tools=${JSON.stringify((m as any).tools ?? []).slice(0, 300)}`);
}
console.log(log.join("\n"));
console.log("\nhand calls:", JSON.stringify(calls, null, 0));
console.log("total ms:", Math.round(performance.now() - t0));
